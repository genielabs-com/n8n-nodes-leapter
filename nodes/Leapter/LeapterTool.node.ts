import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { ZodTypeAny } from 'zod';

import {
	CREDENTIAL_TYPE,
	fetchProjects,
	fetchOperations,
	buildZodSchemaFromOperation,
	sanitizeToolName,
	deduplicateToolNames,
} from './utils';
import type { OpenAPISpec } from './utils';

export class LeapterTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Leapter Tool',
		name: 'leapterTool',
		icon: 'file:leapter.svg',
		group: ['transform'],
		version: 1,
		description: 'Use Leapter blueprints as AI Agent tools',
		defaults: {
			name: 'Leapter Tool',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://github.com/genielabs-com/n8n-nodes-leapter#readme',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tool'],
		credentials: [
			{
				name: 'leapterApi',
				required: true,
			},
		],
		properties: [
			// 1. Project Dropdown
			{
				displayName: 'Project Name or ID',
				name: 'project',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getProjects',
				},
				default: '',
				required: true,
				noDataExpression: true,
				description:
					'The Leapter project whose blueprints will be exposed as AI tools. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// 2. Blueprints Filter (multi-select, empty = all)
			{
				displayName: 'Blueprint Names or IDs',
				name: 'blueprintFilter',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getOperations',
					loadOptionsDependsOn: ['project'],
				},
				default: [],
				noDataExpression: true,
				description:
					'Select specific blueprints to expose as tools. Leave empty to expose all blueprints in the project. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// 3. Tool Description Prefix (optional)
			{
				displayName: 'Tool Description Prefix',
				name: 'toolDescriptionPrefix',
				type: 'string',
				default: '',
				description:
					'Optional text prepended to each tool description. Use this to give the AI extra context about when to use these tools.',
				placeholder: 'e.g. "Use this tool for the Acme project to..."',
			},
		],
	};

	methods = {
		loadOptions: {
			async getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return fetchProjects(this);
			},

			async getOperations(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return fetchOperations(this);
			},
		},
	};

	/**
	 * Called by n8n when the AI Agent invokes the tool.
	 * Receives { blueprint, parameters } from the LLM, resolves the blueprint
	 * to an operation URL via the OpenAPI spec, and executes the HTTP call.
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const executionId = this.getExecutionId() || '';

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const input = items[itemIndex].json;
				const blueprintName = input.blueprint as string | undefined;

				if (!blueprintName) {
					throw new NodeOperationError(
						this.getNode(),
						'Missing "blueprint" in tool input. The AI model must specify which blueprint to execute.',
						{ itemIndex },
					);
				}

				const parameters: Record<string, unknown> =
					typeof input.parameters === 'object' && input.parameters !== null
						? (input.parameters as Record<string, unknown>)
						: {};

				// Parse project compound value: projectId::specUrl::editorBaseUrl::projectName
				const projectValue = this.getNodeParameter('project', itemIndex) as string;
				const projectParts = projectValue.split('::');
				const specUrl = projectParts[1];
				const editorBaseUrl = projectParts[2];

				if (!specUrl || !specUrl.startsWith('http')) {
					throw new NodeOperationError(
						this.getNode(),
						`Invalid project configuration. Cannot parse spec URL from: "${projectValue}"`,
						{ itemIndex },
					);
				}

				// Fetch OpenAPI spec to resolve blueprint name → operation URL
				const spec = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					CREDENTIAL_TYPE,
					{
						method: 'GET',
						url: specUrl,
						json: true,
					},
				)) as OpenAPISpec;

				const serverUrl = (spec.servers?.[0]?.url || '').replace(/\/$/, '');

				if (!serverUrl.startsWith('http')) {
					throw new NodeOperationError(
						this.getNode(),
						`OpenAPI spec server URL is not absolute: "${spec.servers?.[0]?.url}"`,
						{ itemIndex },
					);
				}

				// Find the matching blueprint by sanitized name
				let operationUrl: string | undefined;
				let matchedPath: string | undefined;
				const availableNames: string[] = [];

				for (const [path, pathItem] of Object.entries(spec.paths)) {
					const operation = pathItem.post;
					if (!operation || operation.deprecated) continue;

					const name =
						operation.summary || operation.operationId || path.replace(/\//g, '_');
					const sanitized = sanitizeToolName(name);
					availableNames.push(sanitized);

					if (sanitized === blueprintName) {
						operationUrl = `${serverUrl}${path}`;
						matchedPath = path;
						break;
					}
				}

				if (!operationUrl) {
					throw new NodeOperationError(
						this.getNode(),
						`Blueprint "${blueprintName}" not found. Available: ${availableNames.join(', ')}`,
						{ itemIndex },
					);
				}

				// Execute the blueprint
				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					CREDENTIAL_TYPE,
					{
						method: 'POST',
						url: operationUrl,
						headers: {
							'X-Correlation-Id': executionId,
							'Content-Type': 'application/json',
						},
						body: parameters,
						json: true,
						returnFullResponse: true,
						ignoreHttpStatusErrors: true,
					},
				)) as {
					body: unknown;
					headers: Record<string, string>;
					statusCode: number;
				};

				const statusCode = response.statusCode || 200;
				const responseBody = response.body;

				if (statusCode >= 400) {
					const errorBody =
						typeof responseBody === 'object' && responseBody !== null
							? responseBody
							: {};
					const errorMessage =
						(errorBody as Record<string, string>).detail ||
						(errorBody as Record<string, string>).error ||
						(errorBody as Record<string, string>).message ||
						`Request failed with status ${statusCode}`;

					returnData.push({
						json: { error: errorMessage, statusCode },
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				// Extract metadata
				const runId = response.headers['x-run-id'] || response.headers['X-Run-Id'];
				const modelIdMatch = matchedPath?.match(/\/models\/([^/]+)\/runs/);
				const modelId = modelIdMatch?.[1];
				const editorLink =
					modelId && editorBaseUrl && editorBaseUrl !== 'undefined'
						? `${editorBaseUrl}/${modelId}`
						: '';

				const resultObj =
					typeof responseBody === 'object' && responseBody !== null
						? (responseBody as Record<string, unknown>)
						: { result: responseBody };

				returnData.push({
					json: {
						...resultObj,
						_metadata: { runId, editorLink },
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (error instanceof NodeOperationError) throw error;
				const err = error as Error;
				throw new NodeOperationError(
					this.getNode(),
					`Blueprint execution failed: ${err.message}`,
					{ itemIndex },
				);
			}
		}

		return [returnData];
	}

	/**
	 * Provides a single tool to the AI Agent that can execute any blueprint.
	 * The tool schema has a "blueprint" enum (listing available blueprints)
	 * and a "parameters" object for the blueprint's input data.
	 * When the LLM calls this tool, n8n invokes execute() with the arguments.
	 */
	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		// Lazy imports: @langchain/core and zod are provided by n8n at runtime
		// but not resolvable at module load time in dev mode
		// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
		const { DynamicStructuredTool } = await import('@langchain/core/tools');
		const { z } = await import('zod');

		const projectValue = this.getNodeParameter('project', itemIndex) as string;

		if (!projectValue) {
			throw new NodeOperationError(
				this.getNode(),
				'No project selected. Please select a project first.',
			);
		}

		const blueprintFilter = this.getNodeParameter('blueprintFilter', itemIndex, []) as
			| string[]
			| string;
		const toolDescriptionPrefix = this.getNodeParameter(
			'toolDescriptionPrefix',
			itemIndex,
			'',
		) as string;

		// Parse project compound value: projectId::specUrl::editorBaseUrl::projectName
		const projectParts = projectValue.split('::');
		const specUrl = projectParts[1];
		const projectName = projectParts[3] || 'leapter';

		if (!specUrl || !specUrl.startsWith('http')) {
			throw new NodeOperationError(
				this.getNode(),
				`Invalid project value. Expected compound format but got: "${projectValue}" (parsed specUrl: "${specUrl}")`,
			);
		}

		// Fetch OpenAPI spec
		const spec = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_TYPE,
			{
				method: 'GET',
				url: specUrl,
				json: true,
			},
		)) as OpenAPISpec;

		if (!spec.openapi || !spec.paths) {
			throw new NodeOperationError(this.getNode(), 'Invalid OpenAPI specification');
		}

		if (!spec.servers || spec.servers.length === 0) {
			throw new NodeOperationError(
				this.getNode(),
				'OpenAPI spec must define at least one server URL',
			);
		}

		const rawServerUrl = spec.servers[0].url;
		const serverUrl = rawServerUrl.replace(/\/$/, '');

		if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
			throw new NodeOperationError(
				this.getNode(),
				`OpenAPI spec server URL must be absolute, got: "${rawServerUrl}". ` +
					'The spec.servers[0].url must include the protocol and host.',
			);
		}

		const filterArray: string[] = Array.isArray(blueprintFilter) ? blueprintFilter : [];
		const filterPaths = new Set(
			filterArray.map((v) => {
				const [, filterPath] = v.split('::');
				return filterPath;
			}),
		);
		const hasFilter = filterPaths.size > 0;

		// Collect blueprint entries
		const toolNames: string[] = [];
		const toolEntries: Array<{
			name: string;
			description: string;
			schema: Record<string, ZodTypeAny>;
		}> = [];

		for (const [path, pathItem] of Object.entries(spec.paths)) {
			const operation = pathItem.post;
			if (!operation || operation.deprecated) continue;

			if (hasFilter && !filterPaths.has(path)) continue;

			const blueprintName =
				operation.summary || operation.operationId || path.replace(/\//g, '_');
			const toolName = sanitizeToolName(blueprintName);
			toolNames.push(toolName);

			const description = operation.description || operation.summary || blueprintName;
			const zodShape = buildZodSchemaFromOperation(operation, spec);

			toolEntries.push({
				name: toolName,
				description,
				schema: zodShape,
			});
		}

		if (toolEntries.length === 0) {
			throw new NodeOperationError(
				this.getNode(),
				'No blueprints found in the selected project. Ensure the project has published blueprints.',
			);
		}

		// Deduplicate tool names
		const uniqueNames = deduplicateToolNames(toolNames);

		// Build per-blueprint parameter descriptions for the LLM
		const blueprintDescriptions = toolEntries
			.map((entry, i) => {
				const paramKeys = Object.keys(entry.schema);
				const paramStr =
					paramKeys.length > 0
						? `Parameters: { ${paramKeys.join(', ')} }`
						: 'No parameters required';
				return `- "${uniqueNames[i]}": ${entry.description}. ${paramStr}`;
			})
			.join('\n');

		const toolDescription = [
			toolDescriptionPrefix,
			`Execute Leapter blueprints from the "${projectName}" project.`,
			'',
			'Available blueprints:',
			blueprintDescriptions,
			'',
			'Set "blueprint" to the blueprint name and "parameters" to its input values.',
		]
			.filter((line) => line !== undefined)
			.join('\n');

		// Create a single tool with blueprint selector
		const tool = new DynamicStructuredTool({
			name: sanitizeToolName(`leapter_${projectName}`),
			description: toolDescription,
			schema: z.object({
				blueprint: z
					.enum(uniqueNames as [string, ...string[]])
					.describe('The name of the blueprint to execute'),
				parameters: z
					.record(z.any())
					.optional()
					.describe('Key-value parameters for the selected blueprint'),
			}) as any,
			// func is required by DynamicStructuredTool but n8n calls execute() instead
			func: async (): Promise<string> => {
				return JSON.stringify({
					error: 'Unexpected: func should not be called directly',
				});
			},
			metadata: {
				sourceNodeName: this.getNode().name,
			},
		});

		return { response: tool };
	}
}

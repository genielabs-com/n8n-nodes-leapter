// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { DynamicStructuredTool } from '@langchain/core/tools';
import type {
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { z } from 'zod';

import {
	CREDENTIAL_TYPE,
	fetchProjects,
	fetchOperations,
	buildZodSchemaFromOperation,
	sanitizeToolName,
	deduplicateToolNames,
} from './utils';
import type { OpenAPISpec } from './utils';

/**
 * Creates a DynamicStructuredTool for a single blueprint.
 * Isolated into its own function to prevent TypeScript deep type instantiation
 * errors caused by DynamicStructuredTool's complex generics with dynamic Zod schemas.
 */
function createTool(opts: {
	name: string;
	description: string;
	schema: z.ZodObject<z.ZodRawShape>;
	editorBaseUrl: string;
	path: string;
	operationUrl: string;
	hasSchema: boolean;
	helpers: ISupplyDataFunctions['helpers'];
	context: ISupplyDataFunctions;
	nodeName: string;
	executionId: string;
}): DynamicStructuredTool {
	// @ts-expect-error DynamicStructuredTool generics cause deep type instantiation with dynamic Zod schemas
	return new DynamicStructuredTool({
		name: opts.name,
		description: opts.description,
		schema: opts.schema,
		func: async (toolArgs: Record<string, unknown>): Promise<string> => {
			try {
				const body = opts.hasSchema ? toolArgs : {};

				const response = (await opts.helpers.httpRequestWithAuthentication.call(
					opts.context,
					CREDENTIAL_TYPE,
					{
						method: 'POST',
						url: opts.operationUrl,
						headers: {
							'X-Correlation-Id': opts.executionId,
							'Content-Type': 'application/json',
						},
						body,
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
					return JSON.stringify({ error: errorMessage, statusCode });
				}

				const runId = response.headers['x-run-id'] || response.headers['X-Run-Id'];
				const modelIdMatch = opts.path.match(/\/models\/([^/]+)\/runs/);
				const modelId = modelIdMatch?.[1];
				const editorLink = modelId
					? `${opts.editorBaseUrl}/${modelId}`
					: opts.editorBaseUrl;

				return JSON.stringify({
					...(typeof responseBody === 'object' ? responseBody : { result: responseBody }),
					_metadata: { runId, editorLink },
				});
			} catch (error) {
				const err = error as Error;
				return JSON.stringify({
					error: `Blueprint execution failed: ${err.message}`,
				});
			}
		},
		metadata: {
			sourceNodeName: opts.nodeName,
		},
	});
}

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
				description: 'Select specific blueprints to expose as tools. Leave empty to expose all blueprints in the project. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
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

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
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
		const [, specUrl, editorBaseUrl] = projectValue.split('::');

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

		const serverUrl = spec.servers[0].url.replace(/\/$/, '');

		// Parse the filter values into a Set of compound values for fast lookup
		const filterArray = Array.isArray(blueprintFilter) ? blueprintFilter : [];
		// Extract paths from the compound values for filtering
		const filterPaths = new Set(
			filterArray.map((v) => {
				// compound value: post::path::operationUrl::editorBaseUrl::blueprintName
				const [, filterPath] = v.split('::');
				return filterPath;
			}),
		);
		const hasFilter = filterPaths.size > 0;

		// Build one tool per POST blueprint
		const toolNames: string[] = [];
		const toolEntries: Array<{
			name: string;
			path: string;
			operationUrl: string;
			description: string;
			schema: Record<string, z.ZodTypeAny>;
		}> = [];

		for (const [path, pathItem] of Object.entries(spec.paths)) {
			const operation = pathItem.post;
			if (!operation || operation.deprecated) continue;

			// Apply blueprint filter
			if (hasFilter && !filterPaths.has(path)) continue;

			const blueprintName =
				operation.summary || operation.operationId || path.replace(/\//g, '_');
			const toolName = sanitizeToolName(blueprintName);
			toolNames.push(toolName);

			const operationUrl = `${serverUrl}${path}`;
			const description = [toolDescriptionPrefix, operation.description || operation.summary || blueprintName]
				.filter(Boolean)
				.join(' - ');

			const zodShape = buildZodSchemaFromOperation(operation, spec);

			toolEntries.push({
				name: toolName,
				path,
				operationUrl,
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

		// Capture references for use inside tool func closures
		const helpers = this.helpers;
		const nodeName = this.getNode().name;
		const executionId = this.getExecutionId() || '';

		// Create DynamicStructuredTool instances
		// DynamicStructuredTool generics cause deep type instantiation with dynamic schemas,
		// so we construct tools via a helper that isolates the type complexity.
		const tools = toolEntries.map((entry, i) => {
			const hasSchema = Object.keys(entry.schema).length > 0;
			const zodObject = hasSchema
				? z.object(entry.schema)
				: z.object({ input: z.string().optional().describe('Optional input') });

			return createTool({
				name: uniqueNames[i],
				description: entry.description,
				schema: zodObject,
				editorBaseUrl,
				path: entry.path,
				operationUrl: entry.operationUrl,
				hasSchema,
				helpers,
				context: this,
				nodeName,
				executionId,
			});
		});

		return { response: tools };
	}
}

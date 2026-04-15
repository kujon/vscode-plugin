import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getToolPath } from './ToolManager';

const execAsync = promisify(exec);

const SCHEMA_ID = 'vela-application';
const CACHE_FILENAME = 'vela-application-schema.json';

async function getK8sContext(): Promise<string | null> {
    try {
        const { stdout } = await execAsync(`${getToolPath('kubectl')} config current-context`, { encoding: 'utf-8', timeout: 5_000 });
        return stdout.trim();
    } catch {
        return null;
    }
}

function buildSchemaUri(context: string | null, version: number): string {
    const clusterInfo = context ? `Cluster ${context}` : 'No cluster';
    return `${SCHEMA_ID}://schema/${version}/KubeVela Application | ${clusterInfo}`;
}

const OAM_API_VERSION = 'core.oam.dev/v1beta1';
const OAM_KIND = 'Application';

interface YamlExtensionApi {
    registerContributor(
        schema: string,
        requestSchema: (resource: string) => string | undefined,
        requestSchemaContent: (uri: string) => string | undefined,
        label?: string
    ): boolean;
}

function isVelaApplication(content: string): boolean {
    let hasApiVersion = false;
    let hasKind = false;
    let contentLines = 0;

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
            continue;
        }
        contentLines++;
        if (trimmed === `apiVersion: ${OAM_API_VERSION}`) {
            hasApiVersion = true;
        }
        if (trimmed === `kind: ${OAM_KIND}`) {
            hasKind = true;
        }
        if (hasApiVersion && hasKind) {
            return true;
        }
        if (contentLines >= 10) {
            break;
        }
    }

    return false;
}

const KUBECTL_OPTS = { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 };

async function kubectl(args: string): Promise<string> {
    const { stdout } = await execAsync(`${getToolPath('kubectl')} ${args}`, KUBECTL_OPTS);
    return stdout;
}

type JsonObject = Record<string, unknown>;

const METADATA_RUNTIME_FIELDS = [
    'creationTimestamp', 'deletionGracePeriodSeconds', 'deletionTimestamp',
    'finalizers', 'generation', 'managedFields', 'ownerReferences',
    'resourceVersion', 'selfLink', 'uid',
];

function parseApplicationSchema(oamOpenApiJson: string): JsonObject {
    const spec = JSON.parse(oamOpenApiJson);
    const schemas = spec.components?.schemas ?? {};

    const app = schemas['dev.oam.core.v1beta1.Application'];
    if (!app) {
        throw new Error('Application schema not found in OAM OpenAPI spec');
    }

    const meta = schemas['io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta'];
    if (meta) {
        const metaProps = meta.properties;
        if (metaProps) {
            for (const field of METADATA_RUNTIME_FIELDS) {
                delete metaProps[field];
            }
        }
        delete meta.required;
    }

    const props = app.properties;
    if (props) {
        delete props.status;
        if (meta) {
            props.metadata = meta;
        }
    }

    return app;
}

function filterConfigMapNames(nameListOutput: string, prefix: string): string[] {
    return nameListOutput.trim().split('\n')
        .map(n => n.replace('configmap/', ''))
        .filter(n => n.startsWith(prefix))
        .filter(n => !/-v\d+$/.test(n));
}

interface DefinitionData {
    descriptions: Map<string, string>;
    ignoredFields: Map<string, string[]>;
}

interface DefinitionDataByKind {
    components: DefinitionData;
    traits: DefinitionData;
    policies: DefinitionData;
}

const DEFINITION_KIND_TO_KEY: Record<string, keyof DefinitionDataByKind> = {
    ComponentDefinition: 'components',
    TraitDefinition: 'traits',
    PolicyDefinition: 'policies',
};

interface DefinitionItem {
    kind: string;
    metadata: { name: string; annotations?: Record<string, string> };
    spec?: { schematic?: { cue?: { template?: string } } };
}

function parseDefinitions(definitionsJson: string): DefinitionDataByKind {
    const result: DefinitionDataByKind = {
        components: { descriptions: new Map(), ignoredFields: new Map() },
        traits: { descriptions: new Map(), ignoredFields: new Map() },
        policies: { descriptions: new Map(), ignoredFields: new Map() },
    };
    const items = JSON.parse(definitionsJson).items as DefinitionItem[];
    for (const item of items) {
        const key = DEFINITION_KIND_TO_KEY[item.kind];
        if (!key) { continue; }

        const desc = item.metadata.annotations?.['definition.oam.dev/description'];
        if (desc) {
            result[key].descriptions.set(item.metadata.name, desc);
        }

        const cueTemplate = item.spec?.schematic?.cue?.template;
        if (cueTemplate) {
            const ignored = parseIgnoredFields(cueTemplate);
            if (ignored.length > 0) {
                result[key].ignoredFields.set(item.metadata.name, ignored);
            }
        }
    }
    return result;
}

function parseIgnoredFields(cueTemplate: string): string[] {
    const ignored: string[] = [];
    const lines = cueTemplate.split('\n');

    let inParameter = false;
    let depth = 0;
    let paramDepth = -1;
    let ignoreNext = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (!inParameter) {
            if (/^parameter:\s*\{/.test(trimmed)) {
                inParameter = true;
                paramDepth = depth;
                depth++;
            }
            continue;
        }

        // Track brace depth
        for (const ch of trimmed) {
            if (ch === '{') { depth++; }
            if (ch === '}') { depth--; }
        }

        if (depth <= paramDepth) {
            break; // exited parameter block
        }

        // Only look at the top level of parameter
        if (depth !== paramDepth + 1) {
            continue;
        }

        // Check for // +ignore on its own line
        if (/^\/\/\s*\+ignore\b/.test(trimmed)) {
            ignoreNext = true;
            continue;
        }

        // Check for a field definition
        const fieldMatch = trimmed.match(/^(\w+)\s*\??:/);
        if (fieldMatch) {
            // Trailing // +ignore on the same line
            if (/\/\/\s*\+ignore\b/.test(trimmed)) {
                ignored.push(fieldMatch[1]);
            } else if (ignoreNext) {
                ignored.push(fieldMatch[1]);
            }
            ignoreNext = false;
        }
    }

    return ignored;
}

function parseConfigMapSchema(name: string, prefix: string, cmJson: string): [string, JsonObject] | undefined {
    const cm = JSON.parse(cmJson);
    const type = name.replace(prefix, '');
    const data: Record<string, string> = cm.data ?? {};
    const schemaKey = Object.keys(data).find(k => k.endsWith('.json') || k === 'openapi-v3-json-schema');
    const schemaStr = schemaKey ? data[schemaKey] : Object.values(data)[0];
    if (schemaStr) {
        return [type, JSON.parse(schemaStr)];
    }
    return undefined;
}

function removeIgnoredFields(schema: JsonObject, fields: string[]): JsonObject {
    if (fields.length === 0) { return schema; }

    const result = { ...schema };
    const props = result.properties as JsonObject | undefined;
    if (props) {
        result.properties = { ...props };
        for (const field of fields) {
            delete (result.properties as JsonObject)[field];
        }
    }
    const required = result.required as string[] | undefined;
    if (required) {
        result.required = required.filter(f => !fields.includes(f));
        if ((result.required as string[]).length === 0) {
            delete result.required;
        }
    }
    return result;
}

function applyIgnoredFields(schemas: Map<string, JsonObject>, ignoredFields: Map<string, string[]>): Map<string, JsonObject> {
    if (ignoredFields.size === 0) { return schemas; }
    if (!vscode.workspace.getConfiguration('velaValidation.applications').get<boolean>('excludeIgnoredFields', true)) {
        return schemas;
    }

    const result = new Map<string, JsonObject>();
    for (const [name, schema] of schemas) {
        const fields = ignoredFields.get(name);
        result.set(name, fields ? removeIgnoredFields(schema, fields) : schema);
    }
    return result;
}

const CONDITIONAL_SCHEMA_KEYS = new Set(['if', 'then', 'else']);

function makeDefaultedFieldsOptional(schema: unknown, parentKey?: string): unknown {
    if (Array.isArray(schema)) {
        return schema.map(item => makeDefaultedFieldsOptional(item));
    }
    if (schema !== null && typeof schema === 'object') {
        const obj = schema as JsonObject;
        const result: JsonObject = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = makeDefaultedFieldsOptional(value, key);
        }
        const required = result['required'];
        const properties = result['properties'];
        if (properties && typeof properties === 'object') {
            if (!('additionalProperties' in result) && !('allOf' in result) && !CONDITIONAL_SCHEMA_KEYS.has(parentKey!)) {
                result['additionalProperties'] = false;
            }
            if (Array.isArray(required)) {
                const props = properties as JsonObject;
                result['required'] = required.filter(field => {
                    const prop = props[field as string];
                    return !(prop && typeof prop === 'object' && 'default' in (prop as JsonObject));
                });
                if ((result['required'] as unknown[]).length === 0) {
                    delete result['required'];
                }
            }
        }
        return result;
    }
    return schema;
}

interface DefinitionSchemas {
    schemas: Map<string, JsonObject>;
    descriptions: Map<string, string>;
}

interface SchemasByKind {
    components: DefinitionSchemas;
    traits: DefinitionSchemas;
    policies: DefinitionSchemas;
}

function injectAllOf(itemsNode: JsonObject | undefined, { schemas, descriptions }: DefinitionSchemas): void {
    if (!itemsNode || schemas.size === 0) {
        return;
    }
    const allOf: JsonObject[] = [];
    const typeOneOf: JsonObject[] = [];
    for (const [type, schema] of schemas) {
        allOf.push({
            if: {
                properties: { type: { const: type } },
                required: ['type'],
            },
            then: {
                properties: { properties: schema },
            },
        });
        const entry: JsonObject = { const: type };
        const desc = descriptions.get(type);
        if (desc) {
            entry.description = desc;
        }
        typeOneOf.push(entry);
    }
    itemsNode.allOf = allOf;
    const props = (itemsNode as any).properties;
    if (props?.type) {
        props.type = { ...props.type, oneOf: typeOneOf };
    }
}

function composeSchema(appSchema: JsonObject, schemas: SchemasByKind): JsonObject {
    const spec = (appSchema as any).properties?.spec;
    const componentItems = spec?.properties?.components?.items;

    injectAllOf(componentItems, schemas.components);
    injectAllOf(componentItems?.properties?.traits?.items, schemas.traits);
    injectAllOf(spec?.properties?.policies?.items, schemas.policies);

    console.log('composeSchema: components allOf count:', schemas.components.schemas.size);
    console.log('composeSchema: traits allOf count:', schemas.traits.schemas.size);
    console.log('composeSchema: policies allOf count:', schemas.policies.schemas.size);
    console.log('composeSchema: traits items node exists:', !!componentItems?.properties?.traits?.items);
    console.log('composeSchema: policies items node exists:', !!spec?.properties?.policies?.items);

    return appSchema;
}

export class VelaYamlSchemaProvider {
    private schemaContent: string | undefined;
    private schemaVersion = 0;
    private refreshing = false;
    private cachePath: string;

    constructor(private storagePath: string) {
        this.cachePath = path.join(storagePath, CACHE_FILENAME);
    }

    async register(): Promise<void> {
        await this.loadCache();

        const yamlExtension = vscode.extensions.getExtension<YamlExtensionApi>('redhat.vscode-yaml');
        if (!yamlExtension) {
            console.warn('YAML extension not found. Schema support disabled.');
            return;
        }

        const api = yamlExtension.isActive
            ? yamlExtension.exports
            : await yamlExtension.activate();

        if (!api || !api.registerContributor) {
            console.warn('YAML extension API not available.');
            return;
        }

        api.registerContributor(
            SCHEMA_ID,
            (resource) => this.requestSchema(resource),
            (uri) => this.requestSchemaContent(uri),
            'Vela Application'
        );
    }

    private async loadCache(): Promise<void> {
        try {
            if (fs.existsSync(this.cachePath)) {
                this.schemaContent = await fs.promises.readFile(this.cachePath, 'utf-8');
            }
        } catch (err) {
            console.warn('Failed to load schema cache:', err);
        }
    }

    private async writeCache(content: string): Promise<void> {
        try {
            await fs.promises.mkdir(this.storagePath, { recursive: true });
            await fs.promises.writeFile(this.cachePath, content, 'utf-8');
        } catch (err) {
            console.warn('Failed to write schema cache:', err);
        }
    }

    private async fetchConfigMapSchemas(nameListOutput: string, prefix: string): Promise<Map<string, JsonObject>> {
        const schemas = new Map<string, JsonObject>();
        for (const name of filterConfigMapNames(nameListOutput, prefix)) {
            const entry = parseConfigMapSchema(name, prefix, await kubectl(`get configmap ${name} -n vela-system -o json`));
            if (entry) {
                schemas.set(...entry);
            }
        }
        return schemas;
    }

    private async fetchSchemaFromCluster(): Promise<void> {
        const context = await getK8sContext();
        const appSchema = parseApplicationSchema(await kubectl('get --raw /openapi/v3/apis/core.oam.dev/v1beta1'));
        const cmNameList = await kubectl('get configmaps -n vela-system -o name');
        const defs = parseDefinitions(await kubectl('get componentdefinitions.core.oam.dev,traitdefinitions.core.oam.dev,policydefinitions.core.oam.dev -n vela-system -o json'));
        const schemas: SchemasByKind = {
            components: { schemas: applyIgnoredFields(await this.fetchConfigMapSchemas(cmNameList, 'component-schema-'), defs.components.ignoredFields), descriptions: defs.components.descriptions },
            traits: { schemas: applyIgnoredFields(await this.fetchConfigMapSchemas(cmNameList, 'trait-schema-'), defs.traits.ignoredFields), descriptions: defs.traits.descriptions },
            policies: { schemas: applyIgnoredFields(await this.fetchConfigMapSchemas(cmNameList, 'policy-schema-'), defs.policies.ignoredFields), descriptions: defs.policies.descriptions },
        };
        const composed = makeDefaultedFieldsOptional(composeSchema(appSchema, schemas)) as JsonObject;
        composed.title = context ? `KubeVela Application | Cluster: ${context}` : 'KubeVela Application | No cluster';
        this.schemaContent = JSON.stringify(composed);
        await this.writeCache(this.schemaContent);
    }

    private refreshInBackground(): void {
        if (this.refreshing) {
            return;
        }
        this.refreshing = true;

        (async () => {
            try {
                const context = await getK8sContext();
                const appSchema = parseApplicationSchema(await kubectl('get --raw /openapi/v3/apis/core.oam.dev/v1beta1'));
                const cmNameList = await kubectl('get configmaps -n vela-system -o name');
                const defs = parseDefinitions(await kubectl('get componentdefinitions.core.oam.dev,traitdefinitions.core.oam.dev,policydefinitions.core.oam.dev -n vela-system -o json'));
                const schemas: SchemasByKind = {
                    components: { schemas: applyIgnoredFields(await this.fetchConfigMapSchemas(cmNameList, 'component-schema-'), defs.components.ignoredFields), descriptions: defs.components.descriptions },
                    traits: { schemas: applyIgnoredFields(await this.fetchConfigMapSchemas(cmNameList, 'trait-schema-'), defs.traits.ignoredFields), descriptions: defs.traits.descriptions },
                    policies: { schemas: applyIgnoredFields(await this.fetchConfigMapSchemas(cmNameList, 'policy-schema-'), defs.policies.ignoredFields), descriptions: defs.policies.descriptions },
                };
                const composed = makeDefaultedFieldsOptional(composeSchema(appSchema, schemas)) as JsonObject;
                composed.title = context ? `KubeVela Application | Cluster: ${context}` : 'KubeVela Application | No cluster';
                this.schemaContent = JSON.stringify(composed);
                this.schemaVersion++;
                await this.writeCache(this.schemaContent);
            } catch (err) {
                console.error('Failed to refresh schemas from cluster:', err);
            } finally {
                this.refreshing = false;
            }
        })();
    }

    private requestSchema(resource: string): string | undefined {
        const uri = vscode.Uri.parse(resource);
        if (uri.scheme !== 'file') {
            return undefined;
        }

        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === resource);
        const content = doc
            ? doc.getText()
            : fs.readFileSync(uri.fsPath, 'utf-8');

        if (isVelaApplication(content)) {
            // Fetch context async in background, but return schema URI immediately with null context
            // The schema title will be updated on next refresh
            getK8sContext().then(context => {
                // Trigger schema version update if context is available
                if (context) {
                    this.schemaVersion++;
                }
            }).catch(() => {});

            return buildSchemaUri(null, this.schemaVersion);
        }

        return undefined;
    }

    private requestSchemaContent(uri: string): string | undefined {
        if (!uri.startsWith(`${SCHEMA_ID}://`)) {
            return undefined;
        }

        if (!this.schemaContent) {
            // Trigger async fetch but don't block - return undefined for now
            // The schema will be available on next request after cache loads
            this.fetchSchemaFromCluster().catch((err) => {
                console.error('Failed to fetch schemas from cluster:', err);
            });
            return undefined;
        } else {
            this.refreshInBackground();
        }

        return this.schemaContent;
    }
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import agentRouter from '../agent.ts';
import {
  API_VERSION,
  AGENT_OPERATIONS,
  buildAgentManifest,
  buildOpenApiSpec
} from '../agentContract.ts';
import type {
  AgentManifest,
  AgentManifestAction,
  JsonSchema,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiResponse
} from '../agentContract.ts';

const defaults = {
  adbPath: '/custom/platform-tools/adb',
  adbAddress: '127.0.0.1:7555',
  clientType: 'Bilibili'
};

const expectedAdvertisedIds = [
  'get_status',
  'test_connection',
  'discover_devices',
  'activity_run_preflight',
  'activity_copilot_candidates',
  'run_current_activity_copilots',
  'start_game',
  'fight',
  'run_task',
  'stop_task',
  'get_current_run',
  'get_run',
  'get_screenshot',
  'run_daily_flow',
  'recent_logs',
  'webrtc_status',
  'webrtc_devices',
  'webrtc_start',
  'webrtc_stop',
  'preview_orientation',
  'get_current_activity'
];

/** 断言取值存在：清单/OpenAPI 的嵌套字段在类型层可选，缺失即用例失败。 */
function must<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) assert.fail(`缺少 ${label}`);
  return value;
}

function findAction(manifest: AgentManifest, id: string): AgentManifestAction {
  return must(manifest.actions.find(item => item.id === id), `manifest action ${id}`);
}

function actionById(manifest: AgentManifest): Map<string, AgentManifestAction> {
  return new Map(manifest.actions.map(item => [item.id, item]));
}

function props(schema: JsonSchema | undefined, label: string): Record<string, JsonSchema> {
  return must(schema?.properties, `${label} props`);
}

function prop(schema: JsonSchema | undefined, name: string, label: string): JsonSchema {
  return must(props(schema, label)[name], `${label} ${name}`);
}

function jsonSchemaOf(response: OpenApiResponse, label: string): JsonSchema {
  return must(must(response.content, `${label} content`)['application/json'], `${label} media`).schema;
}

function responseOf(operation: OpenApiOperation, status: string): OpenApiResponse {
  return must(operation.responses[status], `${operation.operationId} ${status} response`);
}

function parameterOf(
  parameters: OpenApiParameter[] | undefined,
  name: string,
  label: string
): OpenApiParameter {
  return must(parameters?.find(item => item.name === name), `${label} ${name} parameter`);
}

function operationAt(spec: OpenApiDocument, path: string, method: string): OpenApiOperation {
  return must(spec.paths[path]?.[method], `${method.toUpperCase()} ${path}`);
}

function getOpenApiOperation(
  spec: OpenApiDocument,
  item: { path: string; method: string }
): OpenApiOperation | undefined {
  return spec.paths[item.path]?.[item.method.toLowerCase()];
}

describe('Agent API contract registry', () => {
  it('keeps operation ids and method/path pairs unique', () => {
    assert.equal(AGENT_OPERATIONS.length, 23);
    assert.equal(new Set(AGENT_OPERATIONS.map(item => item.id)).size, AGENT_OPERATIONS.length);
    assert.equal(
      new Set(AGENT_OPERATIONS.map(item => `${item.method} ${item.path}`)).size,
      AGENT_OPERATIONS.length
    );
  });

  it('advertises the existing actions plus retained run lookup', () => {
    const manifest = buildAgentManifest(defaults);

    assert.equal(manifest.version, API_VERSION);
    assert.deepEqual(manifest.defaults, defaults);
    assert.deepEqual(manifest.actions.map(item => item.id), expectedAdvertisedIds);
    assert.equal(manifest.actions.length, 21);
    assert.ok(!manifest.actions.some(item => item.id === 'get_manifest'));
    assert.ok(!manifest.actions.some(item => item.id === 'get_openapi'));
  });

  it('materializes runtime connection defaults without reading the environment', () => {
    const manifest = buildAgentManifest(defaults);
    const testConnection = findAction(manifest, 'test_connection');
    const startGame = findAction(manifest, 'start_game');

    assert.equal(prop(testConnection.body_schema, 'adbPath', 'test_connection body').default, defaults.adbPath);
    assert.equal(prop(testConnection.body_schema, 'address', 'test_connection body').default, defaults.adbAddress);
    assert.equal(prop(startGame.body_schema, 'clientType', 'start_game body').default, defaults.clientType);
    assert.equal(prop(startGame.body_schema, 'address', 'start_game body').default, defaults.adbAddress);
    assert.ok(!JSON.stringify(manifest).includes('x-la-pluma-runtime-default'));
  });

  it('documents profile selection alongside the compatible direct connection fields', () => {
    const manifest = buildAgentManifest(defaults);
    const byId = actionById(manifest);

    assert.deepEqual(
      Object.keys(props(findAction(manifest, 'test_connection').body_schema, 'test_connection body')),
      ['profileId', 'adbPath', 'address']
    );
    assert.equal(prop(findAction(manifest, 'test_connection').body_schema, 'profileId', 'test_connection body').maxLength, 64);
    assert.equal(
      prop(findAction(manifest, 'test_connection').body_schema, 'profileId', 'test_connection body').pattern,
      '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
    );
    assert.deepEqual(
      Object.keys(props(must(byId.get('discover_devices'), 'discover_devices').query_schema, 'discover_devices query')),
      ['profileId', 'adbPath']
    );
    assert.deepEqual(
      Object.keys(props(must(byId.get('get_screenshot'), 'get_screenshot').body_schema, 'get_screenshot body')),
      ['profileId', 'adbPath', 'address']
    );
    assert.ok(prop(must(byId.get('webrtc_start'), 'webrtc_start').body_schema, 'profileId', 'webrtc_start body'));
    assert.ok(prop(must(byId.get('preview_orientation'), 'preview_orientation').body_schema, 'profileId', 'preview_orientation body'));
  });

  it('publishes recent log options as query schema instead of embedding them in the path', () => {
    const action = findAction(buildAgentManifest(defaults), 'recent_logs');

    assert.equal(action.path, '/api/agent/logs/recent');
    assert.equal(prop(action.query_schema, 'lines', 'recent_logs query').type, 'integer');
    assert.equal(prop(action.query_schema, 'lines', 'recent_logs query').default, 80);
    assert.equal(prop(action.query_schema, 'lines', 'recent_logs query').minimum, 1);
    assert.equal(prop(action.query_schema, 'lines', 'recent_logs query').maximum, 500);
  });

  it('documents the runtime-compatible task command and dynamic task fields', () => {
    const action = findAction(buildAgentManifest(defaults), 'run_task');
    const properties = props(action.body_schema, 'run_task body');

    assert.ok(must(properties.command.enum, 'run_task command enum').includes('run'));
    assert.ok(must(properties.command.enum, 'run_task command enum').includes('list'));
    const taskConfigVariant = must(must(must(properties.taskConfig.oneOf, 'taskConfig oneOf')[0], 'taskConfig variant'), 'taskConfig variant');
    assert.deepEqual(taskConfigVariant.required, ['name', 'type']);
    assert.equal(prop(taskConfigVariant, 'params', 'taskConfig variant').type, 'object');
    assert.equal(properties.taskName.type, 'string');
    assert.equal(properties.taskType.type, 'string');
    assert.equal(properties.userResource.type, 'boolean');
  });

  it('documents retained run lookup and guarded stopping', () => {
    const manifest = buildAgentManifest(defaults);
    const byId = actionById(manifest);
    const getRun = must(byId.get('get_run'), 'get_run');

    assert.equal(manifest.links.run, '/api/agent/runs/{runId}');
    assert.equal(getRun.path, '/api/agent/runs/{runId}');
    assert.deepEqual(getRun.path_schema?.required, ['runId']);
    assert.equal(prop(getRun.path_schema, 'runId', 'get_run path').format, 'uuid');
    assert.equal(prop(must(byId.get('stop_task'), 'stop_task').body_schema, 'runId', 'stop_task body').format, 'uuid');
  });

  it('advertises restart-safe local idempotency for exactly four execution actions', () => {
    const manifest = buildAgentManifest(defaults);
    const runActions = manifest.actions.filter(item => item.execution.producesRun);

    assert.deepEqual(runActions.map(item => item.id), [
      'start_game',
      'fight',
      'run_task',
      'run_daily_flow'
    ]);
    for (const action of runActions) {
      const idempotency = must(action.execution.idempotency, `${action.id} idempotency`);
      assert.equal(action.execution.runLookupAction, 'get_run');
      assert.equal(idempotency.supported, true);
      assert.equal(idempotency.header, 'Idempotency-Key');
      assert.equal(idempotency.scope, 'local-instance');
      assert.equal(idempotency.namespace, 'operationId');
      assert.equal(idempotency.survivesRestart, true);
      assert.equal(idempotency.restartBehavior, 'active-runs-become-interrupted');
      assert.equal(idempotency.retentionSeconds, 86400);
      assert.equal(idempotency.retentionMode, 'up-to');
      assert.equal(idempotency.maxTerminalRuns, 500);
      assert.equal(prop(action.header_schema, 'Idempotency-Key', 'idempotency header').maxLength, 128);
    }
    assert.deepEqual(
      must(
        must(must(runActions.find(item => item.id === 'fight'), 'fight run action').execution.idempotency, 'fight idempotency'),
        'fight idempotency'
      ).appliesWhen,
      { dryRun: false }
    );
    assert.deepEqual(
      must(
        must(
          must(runActions.find(item => item.id === 'run_daily_flow'), 'run_daily_flow run action').execution.idempotency,
          'run_daily_flow idempotency'
        ),
        'run_daily_flow idempotency'
      ).appliesWhen,
      { dryRun: false }
    );

    // 活动作业入口始终同步返回，不能声明 202/接受响应。
    const activityRun = findAction(manifest, 'run_current_activity_copilots');
    assert.equal(activityRun.execution.producesRun, undefined);
    const activityOperation = must(
      getOpenApiOperation(buildOpenApiSpec(defaults), activityRun),
      'run_current_activity_copilots OpenAPI operation'
    );
    assert.equal(activityOperation.responses['202'], undefined);
  });

  // 领域 router 以子 router 挂载在 agent router 上；这里遍历实际挂载关系，
  // 子 router 未挂载或其路由未注册时清单检查会直接失败。
  interface MountedRouteLayer {
    route?: { path: string; methods?: Record<string, boolean> };
    handle?: MountedRouteLayer;
  }

  function collectRouterRoutes(router: unknown, routes = new Set<string>()): Set<string> {
    const stack = (router as { stack?: MountedRouteLayer[] }).stack ?? [];
    for (const layer of stack) {
      if (layer.route) {
        const { path, methods } = layer.route;
        for (const method of Object.keys(methods ?? {})) {
          if (methods?.[method]) routes.add(`${method.toUpperCase()} ${path}`);
        }
        continue;
      }
      if (layer.handle) collectRouterRoutes(layer.handle, routes);
    }
    return routes;
  }

  it('only advertises operations that exist on the mounted Agent router', () => {
    const routes = collectRouterRoutes(agentRouter);
    const manifest = buildAgentManifest(defaults);

    for (const action of manifest.actions) {
      const relativePath = action.path
        .replace(/^\/api\/agent/, '')
        .replace(/\{([^}]+)\}/g, ':$1');
      assert.ok(
        routes.has(`${action.method} ${relativePath}`),
        `missing router declaration for ${action.method} ${action.path}`
      );
    }
  });
});

describe('Agent OpenAPI generation', () => {
  it('publishes the OpenAPI 3.1 dialect', () => {
    assert.equal(buildOpenApiSpec(defaults).openapi, '3.1.0');
  });

  it('turns GET schemas into query parameters and never emits a GET request body', () => {
    const spec = buildOpenApiSpec(defaults);

    for (const item of AGENT_OPERATIONS.filter(item => item.method === 'GET')) {
      const operation = must(getOpenApiOperation(spec, item), `${item.method} ${item.path}`);
      assert.equal(operation.requestBody, undefined, `${item.id} has a request body`);
    }

    const discover = operationAt(spec, '/api/agent/actions/discover-devices', 'get');
    const discoverParameters = new Map(
      must(discover.parameters, 'discover parameters').map(item => [item.name, item])
    );
    assert.equal(must(discoverParameters.get('profileId'), 'profileId parameter').in, 'query');
    assert.equal(
      must(must(discoverParameters.get('adbPath'), 'adbPath parameter').schema, 'adbPath schema').default,
      defaults.adbPath
    );

    const logs = operationAt(spec, '/api/agent/logs/recent', 'get');
    const lines = parameterOf(logs.parameters, 'lines', 'recent logs');
    assert.equal(lines.in, 'query');
    assert.equal(must(lines.schema, 'lines schema').default, 80);
    assert.equal(must(lines.schema, 'lines schema').maximum, 500);
  });

  it('turns the run id schema into a required OpenAPI path parameter', () => {
    const spec = buildOpenApiSpec(defaults);
    const operation = operationAt(spec, '/api/agent/runs/{runId}', 'get');
    const runId = parameterOf(operation.parameters, 'runId', 'run lookup');

    assert.equal(operation.operationId, 'get_run');
    assert.equal(runId.in, 'path');
    assert.equal(runId.required, true);
    assert.equal(must(runId.schema, 'runId schema').format, 'uuid');
    assert.equal(
      jsonSchemaOf(responseOf(operation, '200'), 'run lookup 200').$ref,
      '#/components/schemas/RunResponse'
    );
  });

  it('turns body schemas into JSON request bodies for mutating operations', () => {
    const spec = buildOpenApiSpec(defaults);
    const fight = operationAt(spec, '/api/agent/actions/fight', 'post');
    const requestBody = must(fight.requestBody, 'fight requestBody');
    const schema = must(requestBody.content['application/json'], 'fight media').schema;

    assert.equal(requestBody.required, true);
    assert.deepEqual(schema.required, ['stages']);
    assert.equal(prop(schema, 'dryRun', 'fight body').default, false);
  });

  it('describes success, error, and response metadata envelopes', () => {
    const spec = buildOpenApiSpec(defaults);
    const schemas = spec.components.schemas;
    const success = schemas.SuccessResponse;
    const meta = schemas.ResponseMeta;
    const error = schemas.ErrorResponse;

    assert.deepEqual(success.required, ['success', 'message', 'data', 'meta']);
    assert.equal(prop(success, 'success', 'SuccessResponse').const, true);
    assert.equal(prop(success, 'meta', 'SuccessResponse').$ref, '#/components/schemas/ResponseMeta');
    assert.deepEqual(meta.required, ['requestId', 'dryRun']);
    assert.deepEqual(error.required, ['success', 'message', 'error', 'meta']);
    assert.equal(prop(error, 'success', 'ErrorResponse').const, false);
    assert.equal(prop(error, 'error', 'ErrorResponse').$ref, '#/components/schemas/AgentError');

    for (const item of AGENT_OPERATIONS) {
      const generated = must(getOpenApiOperation(spec, item), `${item.method} ${item.path}`);
      for (const status of ['400', '401', '404', '409', '422', '500']) {
        assert.ok(generated.responses[status], `${item.id} is missing ${status}`);
      }
      if (item.responseKind !== 'openapi' && item.responseKind !== 'run' && item.responseKind !== 'run-snapshot') {
        assert.equal(
          jsonSchemaOf(responseOf(generated, '200'), `${item.id} 200`).$ref,
          '#/components/schemas/SuccessResponse'
        );
      }
    }
  });

  it('supports both optional token authentication forms', () => {
    const spec = buildOpenApiSpec(defaults);
    const schemes = spec.components.securitySchemes;

    assert.equal(must(schemes.bearerAuth, 'bearerAuth').type, 'http');
    assert.equal(must(schemes.bearerAuth, 'bearerAuth').scheme, 'bearer');
    assert.equal(must(schemes.laPlumaToken, 'laPlumaToken').type, 'apiKey');
    assert.equal(must(schemes.laPlumaToken, 'laPlumaToken').in, 'header');
    assert.equal(must(schemes.laPlumaToken, 'laPlumaToken').name, 'X-La-Pluma-Token');
    assert.ok(spec.security.some(requirement => Object.keys(requirement).length === 0));
  });

  it('declares idempotency headers and accepted-run responses on execution actions', () => {
    const spec = buildOpenApiSpec(defaults);
    const runOperations = AGENT_OPERATIONS.filter(item => item.execution.producesRun);
    const header = spec.components.parameters.IdempotencyKey;

    assert.equal(header.name, 'Idempotency-Key');
    assert.equal(header.in, 'header');
    assert.equal(header.required, false);
    assert.equal(must(header.schema, 'idempotency header schema').maxLength, 128);
    const description = must(header.description, 'idempotency header description');
    assert.match(description, /across normal process restarts/);
    assert.match(description, /within the same operation/);
    assert.match(description, /up to 24 hours/);
    assert.match(description, /500-terminal-run cap/);
    assert.match(description, /are not resumed/);

    for (const item of runOperations) {
      const operation = must(getOpenApiOperation(spec, item), `${item.method} ${item.path}`);
      assert.ok(
        must(operation.parameters, `${item.id} parameters`).some(
          parameter => parameter.$ref === '#/components/parameters/IdempotencyKey'
        ),
        `${item.id} is missing Idempotency-Key`
      );
      assert.equal(
        jsonSchemaOf(responseOf(operation, '202'), `${item.id} 202`).$ref,
        '#/components/schemas/SuccessResponse'
      );
      assert.equal(
        must(must(responseOf(operation, '202').headers, 'accepted headers').Location, 'Location header').schema.format,
        'uri-reference'
      );
      assert.equal(
        must(must(responseOf(operation, '202').headers, 'accepted headers')['X-La-Pluma-Run-Id'], 'run id header').schema.format,
        'uuid'
      );
      assert.equal(
        must(must(responseOf(operation, '202').headers, 'accepted headers')['Idempotency-Replayed'], 'replay header').schema.type,
        'boolean'
      );
      assert.equal(responseOf(operation, '503').$ref, '#/components/responses/ServiceUnavailable');
    }
    assert.equal(
      jsonSchemaOf(must(spec.components.responses.ServiceUnavailable, 'ServiceUnavailable'), 'service unavailable').$ref,
      '#/components/schemas/ErrorResponse'
    );
  });

  it('describes retained run state and progress DTOs', () => {
    const schemas = buildOpenApiSpec(defaults).components.schemas;
    const run = schemas.Run;
    const runProperties = props(run, 'Run');

    assert.deepEqual(run.required, ['runId', 'operationId', 'state', 'acceptedAt', 'links']);
    assert.equal(runProperties.runId.format, 'uuid');
    assert.deepEqual(runProperties.state.enum, [
      'accepted', 'waiting', 'running', 'succeeded', 'failed', 'stopping', 'stopped', 'interrupted'
    ]);
    assert.equal(runProperties.progress.$ref, '#/components/schemas/RunProgress');
    assert.equal(runProperties.durationMs.minimum, 0);
    assert.equal(runProperties.error.$ref, '#/components/schemas/RunError');
    assert.equal(runProperties.recovery.$ref, '#/components/schemas/RunRecovery');
    assert.deepEqual(
      schemas.RunRecovery.required,
      ['source', 'previousState', 'executionResumed', 'deviceState']
    );
    assert.equal(prop(schemas.RunRecovery, 'executionResumed', 'RunRecovery').const, false);
    assert.equal(prop(schemas.RunRecovery, 'deviceState', 'RunRecovery').const, 'unknown');
    assert.deepEqual(
      schemas.RunError.required,
      ['code', 'message', 'details', 'retryable', 'statusCode']
    );
    assert.equal(schemas.RunError.additionalProperties, false);
    assert.equal(
      prop(must(must(schemas.RunResponse.allOf, 'RunResponse allOf')[1], 'RunResponse variant'), 'data', 'RunResponse').$ref,
      '#/components/schemas/Run'
    );
  });

  it('describes the run snapshot, occupancy and targeted stop contracts', () => {
    const spec = buildOpenApiSpec(defaults);
    const schemas = spec.components.schemas;
    const current = operationAt(spec, '/api/agent/runs/current', 'get');
    const stop = operationAt(spec, '/api/agent/actions/stop', 'post');

    assert.equal(
      jsonSchemaOf(responseOf(current, '200'), 'current run 200').$ref,
      '#/components/schemas/RunSnapshotResponse'
    );
    assert.equal(
      prop(must(must(schemas.RunSnapshotResponse.allOf, 'RunSnapshotResponse allOf')[1], 'RunSnapshotResponse variant'), 'data', 'RunSnapshotResponse').$ref,
      '#/components/schemas/RunSnapshot'
    );
    assert.deepEqual(
      schemas.RunSnapshot.required,
      ['isRunning', 'schedule', 'recentLogs', 'run', 'activeRuns', 'lastRun', 'occupancy']
    );
    assert.deepEqual(
      prop(schemas.RunOccupancy, 'state', 'RunOccupancy').enum,
      ['idle', 'pending', 'run', 'external', 'unknown']
    );
    assert.deepEqual(
      prop(prop(schemas.RunOccupancy, 'lease', 'RunOccupancy'), 'state', 'RunOccupancy lease').enum,
      ['free', 'held', 'stale', 'unknown']
    );
    const occupancySources = prop(schemas.RunOccupancy, 'sources', 'RunOccupancy');
    assert.deepEqual(must(occupancySources.items, 'sources items').enum, ['run', 'task', 'schedule', 'lease']);
    assert.equal(prop(schemas.ScheduleExecutionSnapshot, 'runId', 'ScheduleExecutionSnapshot').format, 'uuid');

    const guard = parameterOf(stop.parameters, 'runId', 'stop');
    assert.equal(guard.in, 'query');
    assert.equal(guard.required, false);
    assert.equal(must(guard.schema, 'stop runId schema').format, 'uuid');
    assert.equal(
      prop(must(must(stop.requestBody, 'stop requestBody').content['application/json'], 'stop media').schema, 'runId', 'stop body').format,
      'uuid'
    );
  });

  it('marks read-only operations and actual dry-run support explicitly', () => {
    const manifest = buildAgentManifest(defaults);
    const byId = actionById(manifest);

    assert.equal(must(byId.get('recent_logs'), 'recent_logs').safety.readOnly, true);
    assert.equal(must(byId.get('get_status'), 'get_status').safety.readOnly, false);
    assert.deepEqual(must(byId.get('get_status'), 'get_status').safety.sideEffects, ['adb_connect']);
    assert.equal(must(byId.get('get_screenshot'), 'get_screenshot').safety.readOnly, false);
    assert.equal(must(byId.get('fight'), 'fight').safety.readOnly, false);
    assert.equal(must(byId.get('fight'), 'fight').execution.dryRun.supported, true);
    assert.equal(must(byId.get('run_daily_flow'), 'run_daily_flow').execution.supportsDryRun, true);
    assert.equal(must(byId.get('run_daily_flow'), 'run_daily_flow').execution.supportsWaitForCompletion, true);
    assert.equal(
      prop(must(byId.get('run_daily_flow'), 'run_daily_flow').body_schema, 'waitForCompletion', 'run_daily_flow body').default,
      true
    );
    assert.equal(must(byId.get('run_daily_flow'), 'run_daily_flow').execution.mode, 'sync-or-background');
    assert.equal(must(byId.get('preview_orientation'), 'preview_orientation').execution.dryRun.supported, true);
    assert.equal(must(byId.get('run_task'), 'run_task').execution.dryRun.supported, false);
    assert.equal(must(byId.get('run_task'), 'run_task').execution.pollAction, 'get_current_run');
    assert.deepEqual(must(byId.get('run_task'), 'run_task').execution.conflictsWith, ['maa-execution']);
    assert.equal(must(byId.get('stop_task'), 'stop_task').safety.idempotent, true);
    assert.equal(must(byId.get('stop_task'), 'stop_task').safety.destructive, true);
    assert.equal(must(byId.get('webrtc_start'), 'webrtc_start').safety.mutatesDevice, true);
    assert.equal(must(byId.get('webrtc_stop'), 'webrtc_stop').safety.mutatesDevice, true);
    assert.equal(must(byId.get('preview_orientation'), 'preview_orientation').safety.mutatesDevice, true);
  });
});

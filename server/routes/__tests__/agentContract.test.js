import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import agentRouter from '../agent.js';
import {
  API_VERSION,
  AGENT_OPERATIONS,
  buildAgentManifest,
  buildOpenApiSpec
} from '../agentContract.js';

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

function getOpenApiOperation(spec, item) {
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
    const testConnection = manifest.actions.find(item => item.id === 'test_connection');
    const startGame = manifest.actions.find(item => item.id === 'start_game');

    assert.equal(testConnection.body_schema.properties.adbPath.default, defaults.adbPath);
    assert.equal(testConnection.body_schema.properties.address.default, defaults.adbAddress);
    assert.equal(startGame.body_schema.properties.clientType.default, defaults.clientType);
    assert.equal(startGame.body_schema.properties.address.default, defaults.adbAddress);
    assert.ok(!JSON.stringify(manifest).includes('x-la-pluma-runtime-default'));
  });

  it('documents profile selection alongside the compatible direct connection fields', () => {
    const manifest = buildAgentManifest(defaults);
    const byId = new Map(manifest.actions.map(item => [item.id, item]));

    assert.deepEqual(
      Object.keys(byId.get('test_connection').body_schema.properties),
      ['profileId', 'adbPath', 'address']
    );
    assert.equal(byId.get('test_connection').body_schema.properties.profileId.maxLength, 64);
    assert.equal(
      byId.get('test_connection').body_schema.properties.profileId.pattern,
      '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
    );
    assert.deepEqual(
      Object.keys(byId.get('discover_devices').query_schema.properties),
      ['profileId', 'adbPath']
    );
    assert.deepEqual(
      Object.keys(byId.get('get_screenshot').body_schema.properties),
      ['profileId', 'adbPath', 'address']
    );
    assert.ok(byId.get('webrtc_start').body_schema.properties.profileId);
    assert.ok(byId.get('preview_orientation').body_schema.properties.profileId);
  });

  it('publishes recent log options as query schema instead of embedding them in the path', () => {
    const action = buildAgentManifest(defaults).actions.find(item => item.id === 'recent_logs');

    assert.equal(action.path, '/api/agent/logs/recent');
    assert.equal(action.query_schema.properties.lines.type, 'integer');
    assert.equal(action.query_schema.properties.lines.default, 80);
    assert.equal(action.query_schema.properties.lines.minimum, 1);
    assert.equal(action.query_schema.properties.lines.maximum, 500);
  });

  it('documents the runtime-compatible task command and dynamic task fields', () => {
    const action = buildAgentManifest(defaults).actions.find(item => item.id === 'run_task');
    const properties = action.body_schema.properties;

    assert.ok(properties.command.enum.includes('run'));
    assert.ok(properties.command.enum.includes('list'));
    assert.ok(properties.taskConfig.oneOf);
    assert.deepEqual(properties.taskConfig.oneOf[0].required, ['name', 'type']);
    assert.equal(properties.taskConfig.oneOf[0].properties.params.type, 'object');
    assert.equal(properties.taskName.type, 'string');
    assert.equal(properties.taskType.type, 'string');
    assert.equal(properties.userResource.type, 'boolean');
  });

  it('documents retained run lookup and guarded stopping', () => {
    const manifest = buildAgentManifest(defaults);
    const byId = new Map(manifest.actions.map(item => [item.id, item]));
    const getRun = byId.get('get_run');

    assert.equal(manifest.links.run, '/api/agent/runs/{runId}');
    assert.equal(getRun.path, '/api/agent/runs/{runId}');
    assert.deepEqual(getRun.path_schema.required, ['runId']);
    assert.equal(getRun.path_schema.properties.runId.format, 'uuid');
    assert.equal(byId.get('stop_task').body_schema.properties.runId.format, 'uuid');
  });

  it('advertises restart-safe local idempotency for exactly five execution actions', () => {
    const manifest = buildAgentManifest(defaults);
    const runActions = manifest.actions.filter(item => item.execution.producesRun);

    assert.deepEqual(runActions.map(item => item.id), [
      'run_current_activity_copilots',
      'start_game',
      'fight',
      'run_task',
      'run_daily_flow'
    ]);
    for (const action of runActions) {
      assert.equal(action.execution.runLookupAction, 'get_run');
      assert.equal(action.execution.idempotency.supported, true);
      assert.equal(action.execution.idempotency.header, 'Idempotency-Key');
      assert.equal(action.execution.idempotency.scope, 'local-instance');
      assert.equal(action.execution.idempotency.namespace, 'operationId');
      assert.equal(action.execution.idempotency.survivesRestart, true);
      assert.equal(action.execution.idempotency.restartBehavior, 'active-runs-become-interrupted');
      assert.equal(action.execution.idempotency.retentionSeconds, 86400);
      assert.equal(action.execution.idempotency.retentionMode, 'up-to');
      assert.equal(action.execution.idempotency.maxTerminalRuns, 500);
      assert.equal(action.header_schema.properties['Idempotency-Key'].maxLength, 128);
    }
    assert.deepEqual(
      runActions.find(item => item.id === 'fight').execution.idempotency.appliesWhen,
      { dryRun: false }
    );
    assert.deepEqual(
      runActions.find(item => item.id === 'run_daily_flow').execution.idempotency.appliesWhen,
      { dryRun: false }
    );
  });

  // 领域 router 以子 router 挂载在 agent router 上；这里遍历实际挂载关系，
  // 子 router 未挂载或其路由未注册时清单检查会直接失败。
  function collectRouterRoutes(router, routes = new Set()) {
    for (const layer of router.stack) {
      if (layer.route) {
        const { path, methods } = layer.route;
        for (const method of Object.keys(methods ?? {})) {
          if (methods[method]) routes.add(`${method.toUpperCase()} ${path}`);
        }
        continue;
      }
      if (layer.handle?.stack) collectRouterRoutes(layer.handle, routes);
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
  it('generates every registered operation from the shared registry', () => {
    const spec = buildOpenApiSpec(defaults);

    assert.equal(spec.openapi, '3.1.0');
    for (const item of AGENT_OPERATIONS) {
      const generated = getOpenApiOperation(spec, item);
      assert.ok(generated, `missing ${item.method} ${item.path}`);
      assert.equal(generated.operationId, item.id);
      assert.deepEqual(generated.tags, item.tags);
      assert.deepEqual(generated['x-la-pluma-safety'], item.safety);
      assert.deepEqual(generated['x-la-pluma-execution'], item.execution);
    }
  });

  it('keeps manifest actions and OpenAPI operations in sync', () => {
    const manifest = buildAgentManifest(defaults);
    const spec = buildOpenApiSpec(defaults);

    for (const action of manifest.actions) {
      const generated = spec.paths[action.path]?.[action.method.toLowerCase()];
      assert.ok(generated, `OpenAPI is missing advertised action ${action.id}`);
      assert.equal(generated.operationId, action.id);
      assert.deepEqual(generated['x-la-pluma-safety'], action.safety);
      assert.deepEqual(generated['x-la-pluma-execution'], action.execution);
    }
  });

  it('turns GET schemas into query parameters and never emits a GET request body', () => {
    const spec = buildOpenApiSpec(defaults);

    for (const item of AGENT_OPERATIONS.filter(item => item.method === 'GET')) {
      assert.equal(getOpenApiOperation(spec, item).requestBody, undefined, `${item.id} has a request body`);
    }

    const discover = spec.paths['/api/agent/actions/discover-devices'].get;
    const discoverParameters = Object.fromEntries(discover.parameters.map(item => [item.name, item]));
    assert.equal(discoverParameters.profileId.in, 'query');
    assert.equal(discoverParameters.adbPath.schema.default, defaults.adbPath);

    const logs = spec.paths['/api/agent/logs/recent'].get;
    const lines = logs.parameters.find(item => item.name === 'lines');
    assert.equal(lines.in, 'query');
    assert.equal(lines.schema.default, 80);
    assert.equal(lines.schema.maximum, 500);
  });

  it('turns the run id schema into a required OpenAPI path parameter', () => {
    const spec = buildOpenApiSpec(defaults);
    const operation = spec.paths['/api/agent/runs/{runId}'].get;
    const runId = operation.parameters.find(item => item.name === 'runId');

    assert.equal(operation.operationId, 'get_run');
    assert.equal(runId.in, 'path');
    assert.equal(runId.required, true);
    assert.equal(runId.schema.format, 'uuid');
    assert.equal(
      operation.responses['200'].content['application/json'].schema.$ref,
      '#/components/schemas/RunResponse'
    );
  });

  it('turns body schemas into JSON request bodies for mutating operations', () => {
    const spec = buildOpenApiSpec(defaults);
    const fight = spec.paths['/api/agent/actions/fight'].post;
    const schema = fight.requestBody.content['application/json'].schema;

    assert.equal(fight.requestBody.required, true);
    assert.deepEqual(schema.required, ['stages']);
    assert.equal(schema.properties.dryRun.default, false);
  });

  it('describes success, error, and response metadata envelopes', () => {
    const spec = buildOpenApiSpec(defaults);
    const schemas = spec.components.schemas;

    assert.deepEqual(schemas.SuccessResponse.required, ['success', 'message', 'data', 'meta']);
    assert.equal(schemas.SuccessResponse.properties.success.const, true);
    assert.equal(schemas.SuccessResponse.properties.meta.$ref, '#/components/schemas/ResponseMeta');
    assert.deepEqual(schemas.ResponseMeta.required, ['requestId', 'dryRun']);
    assert.deepEqual(schemas.ErrorResponse.required, ['success', 'message', 'error', 'meta']);
    assert.equal(schemas.ErrorResponse.properties.success.const, false);
    assert.equal(schemas.ErrorResponse.properties.error.$ref, '#/components/schemas/AgentError');

    for (const item of AGENT_OPERATIONS) {
      const generated = getOpenApiOperation(spec, item);
      for (const status of ['400', '401', '404', '409', '422', '500']) {
        assert.ok(generated.responses[status], `${item.id} is missing ${status}`);
      }
      if (item.responseKind !== 'openapi' && item.responseKind !== 'run' && item.responseKind !== 'run-snapshot') {
        assert.equal(
          generated.responses['200'].content['application/json'].schema.$ref,
          '#/components/schemas/SuccessResponse'
        );
      }
    }
  });

  it('supports both optional token authentication forms', () => {
    const spec = buildOpenApiSpec(defaults);
    const schemes = spec.components.securitySchemes;

    assert.equal(schemes.bearerAuth.type, 'http');
    assert.equal(schemes.bearerAuth.scheme, 'bearer');
    assert.equal(schemes.laPlumaToken.type, 'apiKey');
    assert.equal(schemes.laPlumaToken.in, 'header');
    assert.equal(schemes.laPlumaToken.name, 'X-La-Pluma-Token');
    assert.ok(spec.security.some(requirement => Object.keys(requirement).length === 0));
  });

  it('declares idempotency headers and accepted-run responses on execution actions', () => {
    const spec = buildOpenApiSpec(defaults);
    const runOperations = AGENT_OPERATIONS.filter(item => item.execution.producesRun);
    const header = spec.components.parameters.IdempotencyKey;

    assert.equal(header.name, 'Idempotency-Key');
    assert.equal(header.in, 'header');
    assert.equal(header.required, false);
    assert.equal(header.schema.maxLength, 128);
    assert.match(header.description, /across normal process restarts/);
    assert.match(header.description, /within the same operation/);
    assert.match(header.description, /up to 24 hours/);
    assert.match(header.description, /500-terminal-run cap/);
    assert.match(header.description, /are not resumed/);

    for (const item of runOperations) {
      const operation = getOpenApiOperation(spec, item);
      assert.ok(
        operation.parameters.some(parameter => parameter.$ref === '#/components/parameters/IdempotencyKey'),
        `${item.id} is missing Idempotency-Key`
      );
      assert.equal(
        operation.responses['202'].content['application/json'].schema.$ref,
        '#/components/schemas/SuccessResponse'
      );
      assert.equal(operation.responses['202'].headers.Location.schema.format, 'uri-reference');
      assert.equal(operation.responses['202'].headers['X-La-Pluma-Run-Id'].schema.format, 'uuid');
      assert.equal(operation.responses['202'].headers['Idempotency-Replayed'].schema.type, 'boolean');
      assert.equal(operation.responses['503'].$ref, '#/components/responses/ServiceUnavailable');
    }
    assert.equal(
      spec.components.responses.ServiceUnavailable.content['application/json'].schema.$ref,
      '#/components/schemas/ErrorResponse'
    );
  });

  it('describes retained run state and progress DTOs', () => {
    const schemas = buildOpenApiSpec(defaults).components.schemas;

    assert.deepEqual(schemas.Run.required, ['runId', 'operationId', 'state', 'acceptedAt', 'links']);
    assert.equal(schemas.Run.properties.runId.format, 'uuid');
    assert.deepEqual(schemas.Run.properties.state.enum, [
      'accepted', 'waiting', 'running', 'succeeded', 'failed', 'stopping', 'stopped', 'interrupted'
    ]);
    assert.equal(schemas.Run.properties.progress.$ref, '#/components/schemas/RunProgress');
    assert.equal(schemas.Run.properties.durationMs.minimum, 0);
    assert.equal(schemas.Run.properties.error.$ref, '#/components/schemas/RunError');
    assert.equal(schemas.Run.properties.recovery.$ref, '#/components/schemas/RunRecovery');
    assert.deepEqual(
      schemas.RunRecovery.required,
      ['source', 'previousState', 'executionResumed', 'deviceState']
    );
    assert.equal(schemas.RunRecovery.properties.executionResumed.const, false);
    assert.equal(schemas.RunRecovery.properties.deviceState.const, 'unknown');
    assert.deepEqual(
      schemas.RunError.required,
      ['code', 'message', 'details', 'retryable', 'statusCode']
    );
    assert.equal(schemas.RunError.additionalProperties, false);
    assert.equal(schemas.RunResponse.allOf[1].properties.data.$ref, '#/components/schemas/Run');
  });

  it('describes the run snapshot, occupancy and targeted stop contracts', () => {
    const spec = buildOpenApiSpec(defaults);
    const schemas = spec.components.schemas;
    const current = spec.paths['/api/agent/runs/current'].get;
    const stop = spec.paths['/api/agent/actions/stop'].post;

    assert.equal(
      current.responses['200'].content['application/json'].schema.$ref,
      '#/components/schemas/RunSnapshotResponse'
    );
    assert.equal(
      schemas.RunSnapshotResponse.allOf[1].properties.data.$ref,
      '#/components/schemas/RunSnapshot'
    );
    assert.deepEqual(
      schemas.RunSnapshot.required,
      ['isRunning', 'schedule', 'recentLogs', 'run', 'activeRuns', 'lastRun', 'occupancy']
    );
    assert.deepEqual(
      schemas.RunOccupancy.properties.state.enum,
      ['idle', 'pending', 'run', 'external', 'unknown']
    );
    assert.deepEqual(
      schemas.RunOccupancy.properties.lease.properties.state.enum,
      ['free', 'held', 'stale', 'unknown']
    );
    assert.deepEqual(
      schemas.RunOccupancy.properties.sources.items.enum,
      ['run', 'task', 'schedule', 'lease']
    );
    assert.equal(schemas.ScheduleExecutionSnapshot.properties.runId.format, 'uuid');

    const guard = stop.parameters.find(item => item.name === 'runId');
    assert.equal(guard.in, 'query');
    assert.equal(guard.required, false);
    assert.equal(guard.schema.format, 'uuid');
    assert.equal(
      stop.requestBody.content['application/json'].schema.properties.runId.format,
      'uuid'
    );
  });

  it('marks read-only operations and actual dry-run support explicitly', () => {
    const manifest = buildAgentManifest(defaults);
    const byId = new Map(manifest.actions.map(item => [item.id, item]));

    assert.equal(byId.get('recent_logs').safety.readOnly, true);
    assert.equal(byId.get('get_status').safety.readOnly, false);
    assert.deepEqual(byId.get('get_status').safety.sideEffects, ['adb_connect']);
    assert.equal(byId.get('get_screenshot').safety.readOnly, false);
    assert.equal(byId.get('fight').safety.readOnly, false);
    assert.equal(byId.get('fight').execution.dryRun.supported, true);
    assert.equal(byId.get('run_daily_flow').execution.supportsDryRun, true);
    assert.equal(byId.get('run_daily_flow').execution.supportsWaitForCompletion, true);
    assert.equal(
      byId.get('run_daily_flow').body_schema.properties.waitForCompletion.default,
      true
    );
    assert.equal(byId.get('run_daily_flow').execution.mode, 'sync-or-background');
    assert.equal(byId.get('preview_orientation').execution.dryRun.supported, true);
    assert.equal(byId.get('run_task').execution.dryRun.supported, false);
    assert.equal(byId.get('run_task').execution.pollAction, 'get_current_run');
    assert.deepEqual(byId.get('run_task').execution.conflictsWith, ['maa-execution']);
    assert.equal(byId.get('stop_task').safety.idempotent, true);
    assert.equal(byId.get('stop_task').safety.destructive, true);
    assert.equal(byId.get('webrtc_start').safety.mutatesDevice, true);
    assert.equal(byId.get('webrtc_stop').safety.mutatesDevice, true);
    assert.equal(byId.get('preview_orientation').safety.mutatesDevice, true);
  });
});

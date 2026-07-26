const CALLBACK_MARKER = 'Assistant::append_callback | ';

export function parseMaaCallbackEvents(logOutput, taskchain) {
  const events = [];

  for (const line of String(logOutput || '').split('\n')) {
    const markerIndex = line.indexOf(CALLBACK_MARKER);
    if (markerIndex === -1) continue;

    const callback = line.slice(markerIndex + CALLBACK_MARKER.length);
    const jsonIndex = callback.indexOf('{');
    if (jsonIndex === -1) continue;

    try {
      const payload = JSON.parse(callback.slice(jsonIndex));
      if (payload.taskchain !== taskchain) continue;
      events.push({
        ...payload,
        callback: callback.slice(0, jsonIndex).trim()
      });
    } catch {
      // Incremental log checkpoints can begin with an incomplete callback line.
    }
  }

  return events;
}

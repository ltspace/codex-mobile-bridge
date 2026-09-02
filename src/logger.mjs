function errorDetails(error) {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: error.stack,
  };
}

function compact(details = {}) {
  return Object.fromEntries(Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, value instanceof Error ? errorDetails(value) : value]));
}

export function createLogger(component, { output = process.stdout, errors = process.stderr } = {}) {
  function write(level, event, details, stream) {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      component,
      event,
      ...compact(details),
    };
    try {
      stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Logging must never take down the bridge.
    }
  }

  return {
    info: (event, details = {}) => write("info", event, details, output),
    warn: (event, details = {}) => write("warn", event, details, errors),
    error: (event, details = {}) => write("error", event, details, errors),
  };
}

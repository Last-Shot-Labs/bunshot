const isDev = process.env.NODE_ENV !== "production";
const verboseEnv = process.env.LOGGING_VERBOSE;

const verbose =
  verboseEnv !== undefined ? verboseEnv === "true" : isDev;

export const log = (...args: unknown[]) => {
  if (verbose) console.log(...args);
};

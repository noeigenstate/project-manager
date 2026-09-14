function createTerminalEnvironment(source, bootstrapFile) {
  const env = { ...source };
  // A terminal window can be launched from a non-interactive host (including
  // Codex tools or CI). Its output policy must not disable colors in our PTYs.
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (['NO_COLOR', 'NODE_DISABLE_COLORS', 'TERM', 'COLORTERM', 'CLICOLOR', 'TERM_PROGRAM',
      'PROJECT_GRID_BOOTSTRAP', 'ELECTRON_RUN_AS_NODE', 'PROJECT_GRID_DATA_DIR', 'PROJECT_GRID_DEV_URL'].includes(name)
      || (name === 'FORCE_COLOR' && ['0', 'false', ''].includes(String(env[key]).toLowerCase()))) {
      delete env[key];
    }
  }
  return {
    ...env,
    PROJECT_GRID_BOOTSTRAP: bootstrapFile,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'project-grid',
    CLICOLOR: '1',
  };
}

module.exports = { createTerminalEnvironment };

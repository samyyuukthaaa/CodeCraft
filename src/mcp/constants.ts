// Pure constants shared by the MCP server, the TrueForge registration and the agent manifest.
export const EDITOR_SERVER_NAME = 'codecraft-editor';
/** Tools that make TrueForge pause the turn for approval before they run. */
export const APPROVAL_TOOLS = ['propose_write', 'propose_changes', 'run_tests'] as const;

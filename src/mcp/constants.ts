// Pure constants shared by the MCP server, the TrueForge registration and the agent manifest.
export const EDITOR_SERVER_NAME = 'codecraft-editor';
/** Tools that make TrueForge pause the turn for approval before they run. */
export const APPROVAL_TOOLS = ['propose_write', 'propose_changes', 'run_tests'] as const;
/** Every editor tool (the MCP server registers exactly these). */
export const EDITOR_TOOLS = ['read_file', 'list_files', 'search_text', 'search_symbols', 'list_related', 'submit_plan', 'propose_changes', 'propose_write', 'run_tests'] as const;

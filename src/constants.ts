export const COLAB_URL = 'https://colab.research.google.com';
export const COLAB_ALT_URL = 'https://colab.google.com';
export const COLAB_NOTEBOOK_PATH = '/notebooks/empty.ipynb';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const JSONRPC_VERSION = '2.0';

export const WS_HOST = '127.0.0.1';
export const WS_TOKEN_LENGTH = 16;

export const CONNECTION_TIMEOUT_MS = 90_000;
export const RPC_REQUEST_TIMEOUT_MS = 120_000;
export const RECONNECT_TIMEOUT_MS = 90_000;
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 60_000;
export const STREAM_POLL_INTERVAL_MS = 500;

export const MCP_ACCEPT_BUTTON_TEXT = 'Connect';
export const PLAYWRIGHT_NAV_TIMEOUT_MS = 30_000;
export const PLAYWRIGHT_ACCEPT_TIMEOUT_MS = 30_000;
export const RUNTIME_DIALOG_TIMEOUT_MS = 10_000;

export const TOOL_ADD_CODE_CELL = 'add_code_cell';
export const TOOL_ADD_TEXT_CELL = 'add_text_cell';
export const TOOL_RUN_CODE_CELL = 'run_code_cell';
export const TOOL_DELETE_CELL = 'delete_cell';
export const TOOL_GET_CELLS = 'get_cells';
export const TOOL_UPDATE_CELL = 'update_cell';
export const TOOL_MOVE_CELL = 'move_cell';

export const TOOL_LIST_WORKFLOWS = 'list_workflows';
export const TOOL_LOAD_WORKFLOW = 'load_workflow';
export const TOOL_UNLOAD_WORKFLOW = 'unload_workflow';
export const TOOL_RUN_WORKFLOW = 'run_workflow';
export const TOOL_STOP_WORKFLOW = 'stop_workflow';

export const WORKFLOW_MCP_TOOLS = [
  TOOL_LIST_WORKFLOWS,
  TOOL_LOAD_WORKFLOW,
  TOOL_UNLOAD_WORKFLOW,
  TOOL_RUN_WORKFLOW,
  TOOL_STOP_WORKFLOW,
] as const;

export const REQUIRED_TOOLS = [
  TOOL_ADD_CODE_CELL,
  TOOL_ADD_TEXT_CELL,
  TOOL_RUN_CODE_CELL,
  TOOL_DELETE_CELL,
  TOOL_GET_CELLS,
  TOOL_UPDATE_CELL,
] as const;

export const GPU_TYPES: Record<string, string> = {
  cpu: 'None (CPU)',
  t4: 'T4 GPU',
  a100: 'A100 GPU',
  v100: 'v100 GPU',
  l4: 'L4 GPU',
  tpu: 'TPU v2',
};

export const HEALTH_CHECK_CODE = `
import json, os, subprocess
info = {'has_gpu': os.path.exists('/dev/nvidia0'), 'gpu_name': ''}
try:
    r = subprocess.run(
        ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
        capture_output=True, text=True, timeout=5,
    )
    if r.returncode == 0:
        info['gpu_name'] = r.stdout.strip()
except Exception:
    pass
print(json.dumps(info))
`.trim();

export const KEEPALIVE_SCRIPT = `
(() => {
  if (window.__colabsdk_keepalive) return;
  window.__colabsdk_keepalive = setInterval(() => {
    const btn = document.querySelector('colab-connect-button');
    btn?.shadowRoot?.querySelector('#connect')?.click();
    document.getElementById('ok')?.click();
    const dlg = document.querySelector('colab-dialog.yes-no-dialog');
    const title = dlg?.querySelector('div.content-area>h2');
    if (title?.innerText === 'Runtime disconnected') {
      dlg?.querySelector('paper-button#ok')?.click();
    }
  }, __INTERVAL__);
})();
`;

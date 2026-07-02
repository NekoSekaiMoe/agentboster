# Permissions and Security Notes

Pi Desktop uses Tauri 2 capabilities to function as a local coding-agent host.

Current capability file:
- `src-tauri/capabilities/default.json`

## Why these permissions exist

The app needs to:
- launch and communicate with Pi runtime processes
- read/write project and session files
- open files/folders through native dialogs
- show native notifications
- manage window interactions

## Important consideration

The current default capability includes broad `$HOME` recursive fs read/write allow rules.
This is practical for local coding workflows, but you should review and tighten this policy for stricter environments.

## Recommendation for enterprise/restricted environments

- fork and tailor `default.json`
- limit allowed filesystem paths to intended workspace roots
- review shell execute allowlists
- validate package installation/update policies

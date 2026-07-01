package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

func registerSandboxSkills(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name: "sandbox_skills",
		Description: `Manage skills in the sandbox workspace. Skills are reusable modules stored in /workspace/skills/{name}/.
Each skill can have:
- SKILL.md: documentation and usage guide
- clawhub.json: OpenClaw/ClawHub manifest with an entrypoint
- index.ts/index.js/index.sh: executable entry point
- package.json/requirements.txt: dependencies

Actions: list, install, deps, info`,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"action": map[string]any{
					"type":        "string",
					"description": "Action to perform: list, install, deps, info",
					"enum":        []string{"list", "install", "deps", "info"},
				},
				"skill_name": map[string]any{
					"type":        "string",
					"description": "Skill name (required for install, deps, info)",
				},
				"packages": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Packages to install (for install action)",
				},
				"manager": map[string]any{
					"type":        "string",
					"description": "Dependency manager: npm, pip. Default: npm",
					"default":     "npm",
				},
			},
			"required": []string{"action"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Action    string   `json:"action"`
			SkillName string   `json:"skill_name"`
			Packages  []string `json:"packages"`
			Manager   string   `json:"manager"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		if params.Manager == "" {
			params.Manager = "npm"
		}

		sbPath, err := getSandboxWorkspace(sbMgr, ctx.SandboxID)
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		switch params.Action {
		case "list":
			jsonStr, err := sandbox.SkillsJSON(sbPath)
			if err != nil {
				return &ToolResult{Success: false, Error: err.Error()}, nil
			}
			return &ToolResult{Success: true, Data: fmt.Sprintf("Installed skills:\n%s", jsonStr)}, nil

		case "info":
			if params.SkillName == "" {
				return &ToolResult{Success: false, Error: "skill_name is required for info action"}, nil
			}
			skills := sandbox.DiscoverSkills(sbPath)
			for _, s := range skills {
				if s.Name == params.SkillName {
					data, _ := json.MarshalIndent(s, "", "  ")
					return &ToolResult{Success: true, Data: string(data)}, nil
				}
			}
			return &ToolResult{Success: false, Error: fmt.Sprintf("skill %q not found", params.SkillName)}, nil

		case "install":
			if params.SkillName == "" {
				return &ToolResult{Success: false, Error: "skill_name is required for install action"}, nil
			}
			skillPath, err := sandbox.EnsureSkillDir(sbPath, params.SkillName)
			if err != nil {
				return &ToolResult{Success: false, Error: err.Error()}, nil
			}

			// Install packages if specified
			if len(params.Packages) > 0 {
				var cmd string
				switch params.Manager {
				case "npm":
					cmd = fmt.Sprintf("cd %s && npm init -y 2>/dev/null && npm install %s 2>&1", skillPath, joinPackages(params.Packages))
				case "pip":
					cmd = fmt.Sprintf("pip install --target %s %s 2>&1", skillPath, joinPackages(params.Packages))
				default:
					return &ToolResult{Success: false, Error: fmt.Sprintf("unsupported manager: %s", params.Manager)}, nil
				}
				result, execErr := sbMgr.Exec(ctx.SandboxID, cmd, nil, 120)
				if execErr != nil {
					return &ToolResult{Success: false, Error: fmt.Sprintf("install error: %v", execErr)}, nil
				}
				return &ToolResult{Success: result.ExitCode == 0, Data: result.Stdout, Error: result.Stderr}, nil
			}

			return &ToolResult{Success: true, Data: fmt.Sprintf("Skill directory created: %s", skillPath)}, nil

		case "deps":
			if params.SkillName == "" {
				return &ToolResult{Success: false, Error: "skill_name is required for deps action"}, nil
			}
			cmd, err := sandbox.SkillDepsInstall(sbPath, params.SkillName, params.Manager)
			if err != nil {
				return &ToolResult{Success: false, Error: err.Error()}, nil
			}
			result, execErr := sbMgr.Exec(ctx.SandboxID, cmd, nil, 120)
			if execErr != nil {
				return &ToolResult{Success: false, Error: fmt.Sprintf("deps install error: %v", execErr)}, nil
			}
			return &ToolResult{Success: result.ExitCode == 0, Data: result.Stdout, Error: result.Stderr}, nil

		default:
			return &ToolResult{Success: false, Error: fmt.Sprintf("unknown action: %s", params.Action)}, nil
		}
	})
}

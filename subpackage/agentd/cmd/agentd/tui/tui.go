package tui

import (
	"fmt"

	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
)

func Run(version, buildTime string) error {
	title := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39")).Render("AgentD Setup")
	var configPath string
	var certDir string
	var action string

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title(title).
				Description(fmt.Sprintf("Version %s, built %s", version, buildTime)).
				Options(
					huh.NewOption("Print recommended commands", "commands"),
					huh.NewOption("Generate certificates next", "certs"),
				).
				Value(&action),
			huh.NewInput().
				Title("Config path").
				Placeholder("agentd.toml").
				Value(&configPath),
			huh.NewInput().
				Title("Certificate directory").
				Placeholder("./certs").
				Value(&certDir),
		),
	)

	if err := form.Run(); err != nil {
		return err
	}
	if configPath == "" {
		configPath = "agentd.toml"
	}
	if certDir == "" {
		certDir = "./certs"
	}

	if action == "certs" {
		fmt.Printf("Run: agentd -gen-certs -cert-dir %s\n", certDir)
		return nil
	}
	fmt.Printf("1. cp agentd.toml.example %s\n", configPath)
	fmt.Printf("2. agentd -gen-certs -cert-dir %s\n", certDir)
	fmt.Printf("3. agentd -config %s\n", configPath)
	return nil
}

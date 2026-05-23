package config

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/spf13/viper"
)

// Config holds the full agentd configuration.
type Config struct {
	Server   ServerConfig   `mapstructure:"server"`
	ClawLess ClawLessConfig `mapstructure:"clawless"`
	Security SecurityConfig `mapstructure:"security"`
	Sandbox  SandboxConfig  `mapstructure:"sandbox"`
	Cache    CacheConfig    `mapstructure:"cache"`
}

type ServerConfig struct {
	Listen      string `mapstructure:"listen"`
	TLSCertPath string `mapstructure:"tls_cert_path"`
	TLSKeyPath  string `mapstructure:"tls_key_path"`
	CAPath      string `mapstructure:"ca_path"`
	// WebUI dual auth (legacy, mTLS is primary)
	WebUIUsername string `mapstructure:"webui_username"`
	WebUIPassword string `mapstructure:"webui_password"`
	// API key for ClawLess → Daemon calls
	ClawLessAPIKey string `mapstructure:"clawless_api_key"`
}

type ClawLessConfig struct {
	BaseURL string `mapstructure:"base_url"`
	// mTLS client cert for Daemon → ClawLess calls
	ClientCertPath string `mapstructure:"client_cert_path"`
	ClientKeyPath  string `mapstructure:"client_key_path"`
	CAPath         string `mapstructure:"ca_path"`
}

type SecurityConfig struct {
	L1Provider  string `mapstructure:"l1_provider"` // local_ollama, remote
	L1Endpoint  string `mapstructure:"l1_endpoint"`
	L1Model     string `mapstructure:"l1_model"`
	L1APIKey    string `mapstructure:"l1_api_key"`
	L1Threshold struct {
		Low    float64 `mapstructure:"low"`
		Medium float64 `mapstructure:"medium"`
		High   float64 `mapstructure:"high"`
	} `mapstructure:"l1_threshold"`
}

type SandboxConfig struct {
	Default     string `mapstructure:"default"`
	ChrootBase  string `mapstructure:"chroot_base"`
	TmpfsSize   string `mapstructure:"tmpfs_size"`
	DockerSocket string `mapstructure:"docker_socket"`
}

type CacheConfig struct {
	Path            string        `mapstructure:"path"`
	SessionMaxSize  int64         `mapstructure:"session_max_size"`
	SyncInterval    time.Duration `mapstructure:"sync_interval"`
	RetryMaxAttempts int          `mapstructure:"retry_max_attempts"`
}

var defaults = Config{
	Server: ServerConfig{
		Listen:        ":18732",
		TLSCertPath:   "",
		TLSKeyPath:    "",
		CAPath:        "",
		ClawLessAPIKey: "",
	},
	ClawLess: ClawLessConfig{
		BaseURL:        "http://localhost:3000",
		ClientCertPath: "",
		ClientKeyPath:  "",
		CAPath:         "",
	},
	Security: SecurityConfig{
		L1Provider: "local_ollama",
		L1Endpoint: "http://localhost:11434/api/generate",
		L1Model:    "tinyllama:latest",
	},
	Sandbox: SandboxConfig{
		Default:      "tmpfs",
		ChrootBase:   "/var/lib/agentd/chroots",
		TmpfsSize:    "512m",
		DockerSocket: "unix:///var/run/docker.sock",
	},
	Cache: CacheConfig{
		Path:            "/tmp/agentd",
		SessionMaxSize:  104857600, // 100MB
		SyncInterval:    30 * time.Second,
		RetryMaxAttempts: 5,
	},
}

// Load reads configuration from file and environment variables.
func Load(path string) (*Config, error) {
	v := viper.New()

	// Apply defaults
	v.SetDefault("server", map[string]any{
		"listen":          defaults.Server.Listen,
		"tls_cert_path":   defaults.Server.TLSCertPath,
		"tls_key_path":    defaults.Server.TLSKeyPath,
		"ca_path":         defaults.Server.CAPath,
		"clawless_api_key": defaults.Server.ClawLessAPIKey,
	})
	v.SetDefault("clawless", map[string]any{
		"base_url":         defaults.ClawLess.BaseURL,
		"client_cert_path": defaults.ClawLess.ClientCertPath,
		"client_key_path":  defaults.ClawLess.ClientKeyPath,
		"ca_path":          defaults.ClawLess.CAPath,
	})
	v.SetDefault("security", map[string]any{
		"l1_provider": defaults.Security.L1Provider,
		"l1_endpoint": defaults.Security.L1Endpoint,
		"l1_model":    defaults.Security.L1Model,
		"l1_api_key":  defaults.Security.L1APIKey,
		"l1_threshold": map[string]any{
			"low":    0.3,
			"medium": 0.7,
			"high":   0.9,
		},
	})
	v.SetDefault("sandbox", map[string]any{
		"default":       defaults.Sandbox.Default,
		"chroot_base":   defaults.Sandbox.ChrootBase,
		"tmpfs_size":    defaults.Sandbox.TmpfsSize,
		"docker_socket": defaults.Sandbox.DockerSocket,
	})
	v.SetDefault("cache", map[string]any{
		"path":              defaults.Cache.Path,
		"session_max_size":  defaults.Cache.SessionMaxSize,
		"sync_interval":     defaults.Cache.SyncInterval.String(),
		"retry_max_attempts": defaults.Cache.RetryMaxAttempts,
	})

	v.SetConfigType("toml")
	if path != "" {
		v.SetConfigFile(path)
	} else {
		v.SetConfigName("agentd")
		v.SetConfigType("toml")
		v.AddConfigPath(".")
		v.AddConfigPath("/etc/agentd")
	}

	// Environment override
	v.SetEnvPrefix("AGENTD")
	v.AutomaticEnv()

	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("read config: %w", err)
		}
		// Config file not found is ok, use defaults + env
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config: %w", err)
	}

	return &cfg, nil
}

// Watch enables hot-reload on the config file.
func Watch(v *viper.Viper, onChange func()) {
	v.WatchConfig()
	v.OnConfigChange(func(_ fsnotify.Event) {
		onChange()
	})
}

// LoadServerTLS loads the server mTLS certificate config.
func LoadServerTLS(cfg *Config) (*tls.Config, error) {
	if cfg.Server.TLSCertPath == "" || cfg.Server.TLSKeyPath == "" {
		return nil, fmt.Errorf("server TLS cert/key not configured")
	}

	cert, err := tls.LoadX509KeyPair(cfg.Server.TLSCertPath, cfg.Server.TLSKeyPath)
	if err != nil {
		return nil, fmt.Errorf("load server cert: %w", err)
	}

	caCert, err := os.ReadFile(cfg.Server.CAPath)
	if err != nil {
		return nil, fmt.Errorf("read CA cert: %w", err)
	}

	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("parse CA cert")
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientCAs:    caPool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS12,
	}, nil
}

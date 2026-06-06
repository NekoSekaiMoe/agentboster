package config

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/spf13/viper"
)

// Config holds the full agentd configuration.
type Config struct {
	Server      ServerConfig      `mapstructure:"server"`
	ClawLess    ClawLessConfig    `mapstructure:"clawless"`
	Security    SecurityConfig    `mapstructure:"security"`
	Sandbox     SandboxConfig     `mapstructure:"sandbox"`
	Cache       CacheConfig       `mapstructure:"cache"`
	Session     SessionConfig     `mapstructure:"session"`
	Worker      WorkerConfig      `mapstructure:"worker"`
	WorkerPool  WorkerPoolConfig  `mapstructure:"worker_pool"`
	TaskSummary TaskSummaryConfig `mapstructure:"task_summary"`
	Logging     LoggingConfig     `mapstructure:"logging"`
}

type TaskSummaryConfig struct {
	AutoUpdate   bool          `mapstructure:"auto_update" default:"true"`
	TidyInterval time.Duration `mapstructure:"tidy_interval" default:"168h"`
	MaxDecisions int           `mapstructure:"max_decisions" default:"50"`
}

// LoggingConfig controls the custom text logger output format.
type LoggingConfig struct {
	Level     string `mapstructure:"level" default:"info"`
	Module    string `mapstructure:"module" default:"AgentD"`
	AddSource bool   `mapstructure:"add_source" default:"true"`
}

type ServerConfig struct {
	Listen        string `mapstructure:"listen" default:":18732"`
	TLSCertPath   string `mapstructure:"tls_cert_path"`
	TLSKeyPath    string `mapstructure:"tls_key_path"`
	CAPath        string `mapstructure:"ca_path"`
	WebUIUsername  string `mapstructure:"webui_username"`
	WebUIPassword  string `mapstructure:"webui_password"`
	ClawLessAPIKey string `mapstructure:"clawless_api_key"`
}

type ClawLessConfig struct {
	BaseURL           string        `mapstructure:"base_url" default:"http://localhost:3000"`
	ClientCertPath    string        `mapstructure:"client_cert_path"`
	ClientKeyPath     string        `mapstructure:"client_key_path"`
	CAPath            string        `mapstructure:"ca_path"`
	HeartbeatInterval time.Duration `mapstructure:"heartbeat_interval" default:"30s"`
	NodeIDFile        string        `mapstructure:"node_id_file" default:"/var/run/agentd.node_id"`
}

type SecurityConfig struct {
	L1Provider  string `mapstructure:"l1_provider" default:"local_ollama"`
	L1Endpoint  string `mapstructure:"l1_endpoint" default:"http://localhost:11434/api/generate"`
	L1Model     string `mapstructure:"l1_model" default:"tinyllama:latest"`
	L1APIKey    string `mapstructure:"l1_api_key"`
	L1Threshold struct {
		Low      float64 `mapstructure:"low" default:"0.4"`
		Medium   float64 `mapstructure:"medium" default:"0.7"`
		High     float64 `mapstructure:"high" default:"0.9"`
		Critical float64 `mapstructure:"critical" default:"0.9"`
	} `mapstructure:"l1_threshold"`
	RunAsUser string `mapstructure:"run_as_user"`
}

type SandboxConfig struct {
	Default           string   `mapstructure:"default" default:"docker"`
	DockerSocket      string   `mapstructure:"docker_socket" default:"unix:///var/run/docker.sock"`
	DockerImage       string   `mapstructure:"docker_image" default:"alpine:edge"`
	DockerDefaultCPU  float64  `mapstructure:"docker_default_cpu" default:"0.25"`
	DockerDefaultMem  string   `mapstructure:"docker_default_memory" default:"256m"`
	DockerStrictCPU   float64  `mapstructure:"docker_strict_cpu" default:"1.0"`
	DockerStrictMem   string   `mapstructure:"docker_strict_memory" default:"512m"`
	LXCDistro         string   `mapstructure:"lxc_default_distro" default:"alpine"`
	LXCRelease        string   `mapstructure:"lxc_default_release" default:"3.21"`
	LXCRootfsBase     string   `mapstructure:"lxc_rootfs_base" default:"/var/lib/agentd/lxc"`
	AllowedImages     []string `mapstructure:"allowed_images"`
	OSEnforce         bool     `mapstructure:"os_enforce" default:"true"`
	SeccompPath       string   `mapstructure:"seccomp_profile_path"`
	NetworkIsolate    bool     `mapstructure:"network_isolate" default:"true"`
}

type CacheConfig struct {
	Path             string        `mapstructure:"path" default:"/tmp/agentd"`
	SessionMaxSize   int64         `mapstructure:"session_max_size" default:"104857600"`
	SyncInterval     time.Duration `mapstructure:"sync_interval" default:"30s"`
	RetryMaxAttempts int           `mapstructure:"retry_max_attempts" default:"5"`
}

type SessionConfig struct {
	MaxCount  int           `mapstructure:"max_count" default:"50"`
	Timeout   time.Duration `mapstructure:"timeout" default:"30m"`
	StorePath string        `mapstructure:"store_path" default:"/tmp/agentd/sessions"`
}

type WorkerConfig struct {
	ReviewPoolSize  int `mapstructure:"review_pool_size"`
	SandboxPoolSize int `mapstructure:"sandbox_pool_size"`
	TaskPoolSize    int `mapstructure:"task_pool_size"`
	MemoryPoolSize  int `mapstructure:"memory_pool_size" default:"2"`
	CleanupPoolSize int `mapstructure:"cleanup_pool_size" default:"1"`
}

// WorkerPoolConfig controls the dynamic worker pool sizing (from Asika).
type WorkerPoolConfig struct {
	MinWorkers    int    `mapstructure:"min_workers" default:"2"`
	MaxWorkers    int    `mapstructure:"max_workers" default:"0"` // 0 = auto (CPU * 4)
	ScaleUpPct    int    `mapstructure:"scale_up_pct" default:"75"`
	ScaleDownPct  int    `mapstructure:"scale_down_pct" default:"25"`
	CooldownSecs  int    `mapstructure:"cooldown_secs" default:"30"`
	StatsInterval string `mapstructure:"stats_interval" default:"30s"`
}

// registerDefaults reads `default` struct tags and registers them with Viper.
// Handles string, bool, int, float64, and time.Duration fields.
func registerDefaults(v *viper.Viper, prefix string, cfg any) {
	rv := reflect.ValueOf(cfg)
	if rv.Kind() == reflect.Ptr {
		rv = rv.Elem()
	}
	rt := rv.Type()

	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		key := field.Tag.Get("mapstructure")
		if key == "" {
			continue
		}
		fullKey := key
		if prefix != "" {
			fullKey = prefix + "." + key
		}

		fv := rv.Field(i)
		switch fv.Kind() {
		case reflect.Struct:
			registerDefaults(v, fullKey, fv.Addr().Interface())
		default:
			tag := field.Tag.Get("default")
			if tag == "" {
				continue
			}
			switch fv.Kind() {
			case reflect.String:
				v.SetDefault(fullKey, tag)
			case reflect.Bool:
				v.SetDefault(fullKey, tag == "true")
			case reflect.Int, reflect.Int64:
				if fv.Kind() == reflect.Int64 && field.Type == reflect.TypeOf(time.Duration(0)) {
					d, _ := time.ParseDuration(tag)
					v.SetDefault(fullKey, d)
				} else {
					n, _ := strconv.Atoi(tag)
					v.SetDefault(fullKey, n)
				}
			case reflect.Float64:
				f, _ := strconv.ParseFloat(tag, 64)
				v.SetDefault(fullKey, f)
			}
		}
	}
}

// sandboxExtras registers slice/map defaults that cannot be expressed as struct tags.
func sandboxExtras(v *viper.Viper) {
	v.SetDefault("sandbox.allowed_images", []string{
		"ubuntu:22.04", "ubuntu:24.04", "alpine:latest", "alpine:edge",
		"golang:1.22", "node:20", "python:3.12",
	})
	v.SetDefault("sandbox.init_commands", []string{
		"apk add --no-cache git curl bash",
		"mkdir -p /workspace",
		"echo 'nameserver 8.8.8.8' > /etc/resolv.conf",
	})
}

// Validate applies runtime-computed defaults and validates ranges.
// Call after Load() returns a Config.
func (c *Config) Validate() {
	if c.Worker.ReviewPoolSize <= 0 {
		c.Worker.ReviewPoolSize = runtime.NumCPU() * 4
	}
	if c.Worker.SandboxPoolSize <= 0 {
		c.Worker.SandboxPoolSize = runtime.NumCPU() * 2
	}
	if c.Worker.TaskPoolSize <= 0 {
		c.Worker.TaskPoolSize = runtime.NumCPU()
	}
	if c.Worker.MemoryPoolSize <= 0 {
		c.Worker.MemoryPoolSize = 2
	}
	if c.Worker.CleanupPoolSize <= 0 {
		c.Worker.CleanupPoolSize = 1
	}
	if c.WorkerPool.MinWorkers <= 0 {
		c.WorkerPool.MinWorkers = 2
	}
	if c.WorkerPool.MaxWorkers <= 0 {
		c.WorkerPool.MaxWorkers = runtime.NumCPU() * 4
	}
	if c.WorkerPool.ScaleUpPct <= 0 {
		c.WorkerPool.ScaleUpPct = 75
	}
	if c.WorkerPool.ScaleDownPct < 0 {
		c.WorkerPool.ScaleDownPct = 25
	}
	if c.WorkerPool.CooldownSecs <= 0 {
		c.WorkerPool.CooldownSecs = 30
	}
	if c.Cache.SessionMaxSize <= 0 {
		c.Cache.SessionMaxSize = 104857600
	}
	if c.Cache.RetryMaxAttempts <= 0 {
		c.Cache.RetryMaxAttempts = 5
	}
}

// Load reads configuration from file and environment variables.
func Load(path string) (*Config, error) {
	v := viper.New()

	registerDefaults(v, "", Config{})
	sandboxExtras(v)

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

	cfg.Validate()
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

// DefaultAgentdTOML returns the default agentd.toml content.
func DefaultAgentdTOML() string {
	var b strings.Builder
	writeSection(&b, "", Config{})
	sandboxExtrasTOML(&b)
	return b.String()
}

func writeSection(b *strings.Builder, prefix string, cfg any) {
	rv := reflect.ValueOf(cfg)
	rt := rv.Type()

	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		key := field.Tag.Get("mapstructure")
		if key == "" {
			continue
		}

		fv := rv.Field(i)
		if fv.Kind() == reflect.Struct && field.Type != reflect.TypeOf(time.Duration(0)) {
			subPrefix := key
			if prefix != "" {
				subPrefix = prefix + "." + key
			}
			b.WriteString(fmt.Sprintf("\n[%s]\n", subPrefix))
			writeSection(b, subPrefix, fv.Interface())
			continue
		}

		tag := field.Tag.Get("default")
		if tag == "" && fv.Kind() == reflect.String {
			tag = `""`
		} else if tag == "" {
			continue
		}

		switch fv.Kind() {
		case reflect.String:
			b.WriteString(fmt.Sprintf("%s = %q\n", key, tag))
		case reflect.Bool:
			b.WriteString(fmt.Sprintf("%s = %s\n", key, tag))
		case reflect.Int, reflect.Int64:
			if field.Type == reflect.TypeOf(time.Duration(0)) {
				b.WriteString(fmt.Sprintf("%s = %q\n", key, tag))
			} else {
				b.WriteString(fmt.Sprintf("%s = %s\n", key, tag))
			}
		case reflect.Float64:
			b.WriteString(fmt.Sprintf("%s = %s\n", key, tag))
		}
	}
}

func sandboxExtrasTOML(b *strings.Builder) {
	b.WriteString(`
[sandbox.docker]
allowed_images = ["ubuntu:22.04", "ubuntu:24.04", "alpine:latest", "alpine:edge", "golang:1.22", "node:20", "python:3.12"]

[sandbox.lxc]
init_commands = [
    "apk add --no-cache git curl bash",
    "mkdir -p /workspace",
    "echo 'nameserver 8.8.8.8' > /etc/resolv.conf",
]
`)
}

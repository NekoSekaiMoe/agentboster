//go:build linux
// +build linux

package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/clawless/agentd/internal/agent"
	"github.com/clawless/agentd/internal/cache"
	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/config"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/persistence"
	"github.com/clawless/agentd/internal/sandbox"
	"github.com/clawless/agentd/internal/security"
	"github.com/clawless/agentd/internal/security/l0_rules"
	"github.com/clawless/agentd/internal/security/l1_scorer"
	"github.com/clawless/agentd/internal/security/l2_auth"
	"github.com/clawless/agentd/internal/server"
	"github.com/clawless/agentd/internal/worker"
	"github.com/gin-gonic/gin"
)

var (
	version   = "0.5.0"
	buildTime = "unknown"
)

// acquireSingleton ensures only one Agent Daemon instance runs on this machine.
// PID file is fixed at /var/run/agentd.pid (not configurable — must be root to write).
// Format: "{pid}\n{unix_timestamp}\n"
// If PID file exists and the referenced process is alive, returns an error.
// Returns a cleanup function that removes the PID file on shutdown.
func acquireSingleton() (func(), error) {
	const pidFile = "/var/run/agentd.pid"

	if err := os.MkdirAll("/var/run", 0o755); err != nil {
		return nil, fmt.Errorf("create /var/run: %w", err)
	}

	if data, err := os.ReadFile(pidFile); err == nil {
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		if len(lines) > 0 {
			if pid, parseErr := strconv.Atoi(lines[0]); parseErr == nil && pid > 0 {
				if proc, findErr := os.FindProcess(pid); findErr == nil {
					err := proc.Signal(syscall.Signal(0))
					if err == nil {
						return nil, fmt.Errorf("Agent Daemon already running (PID: %d)", pid)
					}
					var errno syscall.Errno
					if errors.As(err, &errno) && errno == syscall.EPERM {
						return nil, fmt.Errorf("Agent Daemon already running (PID: %d, different user)", pid)
					}
				}
			}
		}
	}

	pid := os.Getpid()
	content := fmt.Sprintf("%d\n%d\n", pid, time.Now().Unix())
	if err := os.WriteFile(pidFile, []byte(content), 0o644); err != nil {
		return nil, fmt.Errorf("write pid file: %w", err)
	}

	slog.Info("singleton lock acquired", "pid_file", pidFile, "pid", pid)

	return func() {
		if err := os.Remove(pidFile); err != nil && !os.IsNotExist(err) {
			slog.Warn("failed to remove pid file", "path", pidFile, "error", err)
		} else {
			slog.Info("singleton lock released", "pid_file", pidFile)
		}
	}, nil
}

func main() {
	// Runtime OS check — hard fail on non-Linux
	if runtime.GOOS != "linux" {
		fmt.Fprintf(os.Stderr, "FATAL: Agent Daemon requires Linux. Current OS: %s\n", runtime.GOOS)
		os.Exit(1)
	}

	// Root check — hard fail for non-root
	if os.Getuid() != 0 {
		fmt.Fprintf(os.Stderr, "FATAL: Agent Daemon must be run as root (current uid: %d)\n", os.Getuid())
		os.Exit(1)
	}

	var (
		configPath = flag.String("config", "", "Path to agentd.toml config file")
		genCerts   = flag.Bool("gen-certs", false, "Generate mTLS certificates and exit")
		certDir    = flag.String("cert-dir", "./certs", "Directory for generated certificates")
	)
	flag.Parse()

	if *genCerts {
		if err := generateCerts(*certDir); err != nil {
			fmt.Fprintf(os.Stderr, "failed to generate certificates: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Certificates generated in %s\n", *certDir)
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load config: %v\n", err)
		os.Exit(1)
	}

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	slog.Info("Agent Daemon starting",
		"version", version,
		"build_time", buildTime,
		"listen", cfg.Server.Listen,
	)

	// === Singleton Guard ===
	releaseSingleton, err := acquireSingleton()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}
	defer releaseSingleton()

	// === Node Identity ===
	nodeID, err := nodeIdentity(cfg.ClawLess.NodeIDFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}
	slog.Info("node identity ready", "node_id", nodeID)

	// === Metrics Collector (root-only, writes to file) ===
	metricsPath := filepath.Join(cfg.Cache.Path, "metrics.json")
	if cfg.Cache.Path == "" {
		metricsPath = "/tmp/agentd/metrics.json"
	}
	metricsCollector := startMetricsCollector(nodeID, metricsPath, 10*time.Second)
	defer metricsCollector.Stop()

	// === Drop Privileges ===
	if err := dropPrivileges(cfg.Security.RunAsUser); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}

	// === Security ===
	l0Engine := l0_rules.NewEngine()
	l1Scorer := l1_scorer.NewL1Scorer(&cfg.Security)
	bus := eventbus.New()

	l2Manager := l2_auth.NewL2AuthManager(nil, "default")
	l2Manager.SetBus(bus)

	// Decision queue for serializing L2 authorization requests
	decisionQueue := l2_auth.NewDecisionQueue(bus)
	l2Manager.SetDecisionQueue(decisionQueue)
	defer decisionQueue.Stop()

	l2CleanupStop := l2Manager.StartCleanupWithInterval(30 * time.Second)
	defer l2CleanupStop()

	gk := security.NewGatekeeper(l0Engine, l1Scorer, l2Manager, bus, "default")

	// === ClawLess Client ===
	clawlessClient, err := clawless.NewClientFromConfig(
		cfg.ClawLess.BaseURL,
		cfg.Server.ClawLessAPIKey,
		cfg.ClawLess.ClientCertPath,
		cfg.ClawLess.ClientKeyPath,
		cfg.ClawLess.CAPath,
	)
	if err != nil {
		slog.Warn("ClawLess client mTLS not configured, using plain HTTP", "error", err)
		clawlessClient = clawless.NewClient(cfg.ClawLess.BaseURL, cfg.Server.ClawLessAPIKey, nil)
	}
	l2Manager.SetClawlessClient(clawlessClient)

	// === Node Registration ===
	registerNode(clawlessClient, nodeID, cfg)

	// === Heartbeat ===
	startHeartbeat(clawlessClient, nodeID, cfg.ClawLess.HeartbeatInterval, metricsPath)

	// === L0 hot-reload ===
	l0Loader := l0_rules.NewLoader(l0Engine, clawlessClient, "default", 5*time.Minute)
	l0Loader.Start()
	defer l0Loader.Stop()

	// === Sandbox ===
	sbManager := sandbox.NewManager(cfg)

	// === Agent Manager ===
	agentMgr := agent.NewManager(sbManager, clawlessClient, l1Scorer, cfg)
	agentMgr.SetBus(bus)
	agentMgr.SetDecisionQueue(decisionQueue)
	agentMgr.SetGatekeeper(gk)

	// === Dispatcher ===
	workerSizes := worker.PoolSizes{
		Review:  cfg.Worker.ReviewPoolSize,
		Sandbox: cfg.Worker.SandboxPoolSize,
		Task:    cfg.Worker.TaskPoolSize,
		Memory:  cfg.Worker.MemoryPoolSize,
		Cleanup: cfg.Worker.CleanupPoolSize,
	}
	dispatcher := worker.NewDispatcher(bus, workerSizes, gk, sbManager, clawlessClient, agentMgr)
	dispatcher.Start()
	defer dispatcher.Stop()

	// === Persistence ===
	basePath := cfg.Cache.Path
	if basePath == "" {
		basePath = "/tmp/agentd"
	}

	pendingL2Store, err := persistence.NewPendingL2Store(persistence.PendingL2Path(basePath))
	if err != nil {
		slog.Warn("pending L2 store init failed", "error", err)
	} else if err := pendingL2Store.Restore(); err != nil {
		slog.Warn("pending L2 store restore failed", "error", err)
	}
	l2Manager.SetPendingL2Store(pendingL2Store)

	bgTaskStore, err := persistence.NewBackgroundTaskStore(persistence.BackgroundTaskPath(basePath))
	if err != nil {
		slog.Warn("background task store init failed", "error", err)
	} else if err := bgTaskStore.Restore(); err != nil {
		slog.Warn("background task store restore failed", "error", err)
	}
	agentMgr.SetBGTaskStore(bgTaskStore)

	// === Cache ===
	cacheMgr := cache.NewManager(cfg.Cache.Path, cfg.Cache.SessionMaxSize)
	if err := cacheMgr.Init(); err != nil {
		slog.Warn("cache init failed", "error", err)
	}
	cacheMgr.StartPeriodicSync(cfg.Cache.SyncInterval)
	defer cacheMgr.StopPeriodicSync()

	// === HTTP Server ===
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	srv := server.NewServer(cfg, bus, dispatcher, clawlessClient, cacheMgr, agentMgr, l2Manager)
	srv.RegisterRoutes(r)

	var tlsConfig *tls.Config
	if cfg.Server.TLSCertPath != "" && cfg.Server.TLSKeyPath != "" {
		tlsConfig, err = config.LoadServerTLS(cfg)
		if err != nil {
			slog.Warn("mTLS not configured, falling back to plain TLS", "error", err)
			tlsConfig = nil
		}
	}

	httpServer := &http.Server{
		Addr:      cfg.Server.Listen,
		Handler:   r,
		TLSConfig: tlsConfig,
	}

	go func() {
		var serveErr error
		if tlsConfig != nil {
			serveErr = httpServer.ListenAndServeTLS("", "")
		} else {
			slog.Warn("running without TLS — not recommended for production")
			serveErr = httpServer.ListenAndServe()
		}
		if serveErr != nil && serveErr != http.ErrServerClosed {
			slog.Error("server error", "error", serveErr)
		}
	}()

	slog.Info("Agent Daemon started", "addr", cfg.Server.Listen)

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("Agent Daemon shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		slog.Error("server shutdown error", "error", err)
	}

	slog.Info("Agent Daemon stopped")
}

func registerNode(client *clawless.Client, nodeID string, cfg *config.Config) {
	reqBody := map[string]any{
		"node_id":    nodeID,
		"ip":         getNodeIP(),
		"port":       getListenPort(cfg.Server.Listen),
		"sandboxes":  []string{"tmpfs", "chroot", "docker"},
		"version":    version,
	}

		go func() {
		for attempt := 1; attempt <= 5; attempt++ {
			var resp struct {
				NodeID   string `json:"node_id"`
				Interval int    `json:"interval"`
			}
			err := client.PostJSON(context.Background(), "/api/agentd/v1/nodes/register", reqBody, &resp)
			if err == nil {
				slog.Info("node registered", "node_id", resp.NodeID, "interval", resp.Interval)
				return
			}
			slog.Warn("node register failed", "attempt", attempt, "error", err)
			time.Sleep(time.Duration(attempt) * 3 * time.Second)
		}
		slog.Error("node register failed after 5 attempts")
	}()
}

func startHeartbeat(client *clawless.Client, nodeID string, interval time.Duration, metricsPath string) {
	if interval <= 0 {
		interval = 30 * time.Second
	}

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			<-ticker.C
			metrics, err := readMetrics(metricsPath)
			if err != nil {
				slog.Warn("heartbeat: failed to read metrics", "error", err)
				continue
			}

			reqBody := map[string]any{
				"node_id":          nodeID,
				"cpu_usage":        metrics["cpu_usage"],
				"mem_avail":        metrics["mem_avail"],
				"disk_avail":       metrics["disk_avail"],
				"active_tasks":     0,
				"active_sandboxes": 0,
				"timestamp":        time.Now().Unix(),
			}

			var resp struct {
				Accepted bool `json:"accepted"`
			}
			if err := client.PostJSON(context.Background(), "/api/agentd/v1/nodes/heartbeat", reqBody, &resp); err != nil {
				slog.Warn("heartbeat failed", "error", err)
			}
		}
	}()
}

func getNodeIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() {
			if ipNet.IP.To4() != nil {
				return ipNet.IP.String()
			}
		}
	}
	return "127.0.0.1"
}

func getListenPort(listen string) int {
	_, portStr, err := net.SplitHostPort(listen)
	if err != nil {
		return 18732
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return 18732
	}
	return port
}

func generateCerts(dir string) error {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create cert dir: %w", err)
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate CA key: %w", err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Organization: []string{"AgentD"}, CommonName: "AgentD CA"},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		IsCA:                  true,
		MaxPathLen:            1,
		BasicConstraintsValid: true,
	}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	caKeyDER, _ := x509.MarshalECPrivateKey(caKey)
	writePEM(dir, "ca-cert.pem", "CERTIFICATE", caDER)
	writePEM(dir, "ca-key.pem", "EC PRIVATE KEY", caKeyDER)

	serverKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{Organization: []string{"AgentD"}, CommonName: "agentd-server"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		DNSNames:     []string{"localhost", "agentd-server"},
	}
	serverDER, _ := x509.CreateCertificate(rand.Reader, serverTemplate, caTemplate, &serverKey.PublicKey, caKey)
	serverKeyDER, _ := x509.MarshalECPrivateKey(serverKey)
	writePEM(dir, "server-cert.pem", "CERTIFICATE", serverDER)
	writePEM(dir, "server-key.pem", "EC PRIVATE KEY", serverKeyDER)

	clientKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	clientTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(3),
		Subject:      pkix.Name{Organization: []string{"AgentD"}, CommonName: "agentd-client"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	clientDER, _ := x509.CreateCertificate(rand.Reader, clientTemplate, caTemplate, &clientKey.PublicKey, caKey)
	clientKeyDER, _ := x509.MarshalECPrivateKey(clientKey)
	writePEM(dir, "client-cert.pem", "CERTIFICATE", clientDER)
	writePEM(dir, "client-key.pem", "EC PRIVATE KEY", clientKeyDER)

	fmt.Printf("Generated mTLS certificates in %s:\n", dir)
	fmt.Println("  ca-cert.pem / ca-key.pem       — CA")
	fmt.Println("  server-cert.pem / server-key.pem — Server")
	fmt.Println("  client-cert.pem / client-key.pem — Client (ClawLess → Daemon)")
	return nil
}

func writePEM(dir, filename, typ string, der []byte) {
	path := dir + "/" + filename
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return
	}
	defer f.Close()
	pem.Encode(f, &pem.Block{Type: typ, Bytes: der})
}

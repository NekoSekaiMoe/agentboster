//go:build linux
// +build linux

package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/clawless/agentd/internal/agent"
	"github.com/clawless/agentd/internal/cache"
	"github.com/clawless/agentd/internal/certs"
	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/config"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/identity"
	"github.com/clawless/agentd/internal/lifecycle"
	"github.com/clawless/agentd/internal/metrics"
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

func main() {
	if runtime.GOOS != "linux" {
		fmt.Fprintf(os.Stderr, "FATAL: Agent Daemon requires Linux. Current OS: %s\n", runtime.GOOS)
		os.Exit(1)
	}
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
		if err := certs.Generate(*certDir); err != nil {
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
		"version", version, "build_time", buildTime, "listen", cfg.Server.Listen,
	)

	releaseSingleton, err := lifecycle.AcquireSingleton()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}
	defer releaseSingleton()

	nodeID, err := identity.Resolve(cfg.ClawLess.NodeIDFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}
	slog.Info("node identity ready", "node_id", nodeID)

	metricsPath := filepath.Join(cfg.Cache.Path, "metrics.json")
	if cfg.Cache.Path == "" {
		metricsPath = "/tmp/agentd/metrics.json"
	}
	collector := metrics.New(nodeID, metricsPath, 10*time.Second)
	defer collector.Stop()

	if err := security.DropPrivileges(cfg.Security.RunAsUser); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}

	l0Engine := l0_rules.NewEngine()
	l1Scorer := l1_scorer.NewL1Scorer(&cfg.Security)
	bus := eventbus.New()

	l2Manager := l2_auth.NewL2AuthManager(nil, "default")
	l2Manager.SetBus(bus)

	decisionQueue := l2_auth.NewDecisionQueue(bus)
	l2Manager.SetDecisionQueue(decisionQueue)
	defer decisionQueue.Stop()

	l2CleanupStop := l2Manager.StartCleanupWithInterval(30 * time.Second)
	defer l2CleanupStop()

	gk := security.NewGatekeeper(l0Engine, l1Scorer, l2Manager, bus, "default")

	clawlessClient, err := clawless.NewClientFromConfig(
		cfg.ClawLess.BaseURL, cfg.Server.ClawLessAPIKey,
		cfg.ClawLess.ClientCertPath, cfg.ClawLess.ClientKeyPath, cfg.ClawLess.CAPath,
	)
	if err != nil {
		slog.Warn("ClawLess client mTLS not configured, using plain HTTP", "error", err)
		clawlessClient = clawless.NewClient(cfg.ClawLess.BaseURL, cfg.Server.ClawLessAPIKey, nil)
	}
	l2Manager.SetClawlessClient(clawlessClient)

	lifecycle.RegisterNode(clawlessClient, nodeID, cfg, version)
	lifecycle.StartHeartbeat(clawlessClient, nodeID, cfg.ClawLess.HeartbeatInterval, metricsPath)

	l0Loader := l0_rules.NewLoader(l0Engine, clawlessClient, "default", 5*time.Minute)
	l0Loader.Start()
	defer l0Loader.Stop()

	sbManager := sandbox.NewManager(cfg)

	// Docker availability check and image pre-pull
	if err := sandbox.CheckDockerAvailable(cfg.Sandbox.DockerSocket); err != nil {
		slog.Warn("Docker not available, docker sandboxes will not work", "error", err)
	} else {
		slog.Info("Docker available, pre-pulling light image", "image", cfg.Sandbox.DockerImage)
		if err := sandbox.PrePullDockerImage(cfg.Sandbox.DockerImage); err != nil {
			slog.Warn("Docker image pre-pull failed (will pull on demand)", "image", cfg.Sandbox.DockerImage, "error", err)
		}
	}

	// LXC availability check
	if err := sandbox.CheckLXCAvailable(); err != nil {
		slog.Warn("LXC not available, only Docker sandboxes will work", "error", err)
	} else {
		slog.Info("LXC available for persistent containers")
	}

	agentMgr := agent.NewManager(sbManager, clawlessClient, l1Scorer, cfg)
	agentMgr.SetBus(bus)
	agentMgr.SetDecisionQueue(decisionQueue)
	agentMgr.SetGatekeeper(gk)

	workerSizes := worker.PoolSizes{
		Review: cfg.Worker.ReviewPoolSize, Sandbox: cfg.Worker.SandboxPoolSize,
		Task: cfg.Worker.TaskPoolSize, Memory: cfg.Worker.MemoryPoolSize,
		Cleanup: cfg.Worker.CleanupPoolSize,
	}
	dispatcher := worker.NewDispatcher(bus, workerSizes, gk, sbManager, clawlessClient, agentMgr, cfg.TaskSummary.TidyInterval)
	dispatcher.Start()
	defer dispatcher.Stop()

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

	cacheMgr := cache.NewManager(cfg.Cache.Path, cfg.Cache.SessionMaxSize)
	if err := cacheMgr.Init(); err != nil {
		slog.Warn("cache init failed", "error", err)
	}
	cacheMgr.StartPeriodicSync(cfg.Cache.SyncInterval)
	defer cacheMgr.StopPeriodicSync()

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
		Addr: cfg.Server.Listen, Handler: r, TLSConfig: tlsConfig,
	}

	go func() {
		if err := lifecycle.ListenAndServe(httpServer); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
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

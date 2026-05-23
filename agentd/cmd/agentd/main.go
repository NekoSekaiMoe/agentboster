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
	"syscall"
	"time"

	"github.com/clawless/agentd/internal/cache"
	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/config"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/server"
	"github.com/clawless/agentd/internal/worker"
	"github.com/gin-gonic/gin"
)

var (
	version   = "0.1.0"
	buildTime = "unknown"
)

func main() {
	var (
		configPath = flag.String("config", "", "Path to agentd.toml config file")
		genCerts   = flag.Bool("gen-certs", false, "Generate mTLS certificates and exit")
		certDir    = flag.String("cert-dir", "./certs", "Directory for generated certificates")
	)
	flag.Parse()

	// Handle cert generation
	if *genCerts {
		if err := generateCerts(*certDir); err != nil {
			fmt.Fprintf(os.Stderr, "failed to generate certificates: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Certificates generated in %s\n", *certDir)
		return
	}

	// Load configuration
	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load config: %v\n", err)
		os.Exit(1)
	}

	// Setup logger
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	slog.Info("Agent Daemon starting",
		"version", version,
		"build_time", buildTime,
		"listen", cfg.Server.Listen,
	)

	// Initialize components
	bus := eventbus.New()
	dispatcher := worker.NewDispatcher(bus, config.NumCPU())
	dispatcher.Start()
	defer dispatcher.Stop()

	// ClawLess API client
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

	// Local cache manager
	cacheMgr := cache.NewManager(cfg.Cache.Path, cfg.Cache.SessionMaxSize)
	cacheMgr.StartPeriodicSync(cfg.Cache.SyncInterval)
	defer cacheMgr.StopPeriodicSync()

	// Setup HTTP server
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	srv := server.NewServer(cfg, bus, dispatcher, clawlessClient, cacheMgr)
	srv.RegisterRoutes(r)

	// Configure TLS
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

	// Start server
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

	// Wait for shutdown signal
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

// generateCerts generates a self-signed CA, server cert, and client cert for mTLS.
func generateCerts(dir string) error {
	// Will be implemented with crypto/x509
	return fmt.Errorf("not implemented in Phase 1 — will be added in Phase 2")
}

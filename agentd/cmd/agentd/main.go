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
	"flag"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/clawless/agentd/internal/cache"
	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/config"
	"github.com/clawless/agentd/internal/eventbus"
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
	version   = "0.4.0"
	buildTime = "unknown"
)

func main() {
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

	// === Initialize Security Components ===

	// L0: Rules engine
	l0Engine := l0_rules.NewEngine()

	// L1: Scorer
	l1Scorer := l1_scorer.NewL1Scorer(&cfg.Security)

	// L2: Auth manager
	l2Manager := l2_auth.NewL2AuthManager(nil, "default") // clawless client set later
	l2CleanupStop := l2Manager.StartCleanup(1 * time.Minute)
	defer l2CleanupStop()

	// Gatekeeper: L0 → L1 → L2 pipeline
	bus := eventbus.New()
	gk := security.NewGatekeeper(l0Engine, l1Scorer, l2Manager, bus, "default")

	// === Initialize ClawLess API client ===
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

	// Set clawless client on L2 manager
	l2Manager.SetClawlessClient(clawlessClient)

	// === Initialize L0 rules hot-reload ===
	l0Loader := l0_rules.NewLoader(l0Engine, clawlessClient, "default", 5*time.Minute)
	l0Loader.Start()
	defer l0Loader.Stop()

	// === Initialize sandbox manager ===
	sbManager := sandbox.NewManager(cfg)

	// === Initialize dispatcher ===
	dispatcher := worker.NewDispatcher(bus, config.NumCPU(), gk, sbManager, clawlessClient)
	dispatcher.Start()
	defer dispatcher.Stop()

	// === Initialize cache ===
	cacheMgr := cache.NewManager(cfg.Cache.Path, cfg.Cache.SessionMaxSize)
	if err := cacheMgr.Init(); err != nil {
		slog.Warn("cache init failed", "error", err)
	}
	cacheMgr.StartPeriodicSync(cfg.Cache.SyncInterval)
	defer cacheMgr.StopPeriodicSync()

	// === Setup HTTP server ===
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	srv := server.NewServer(cfg, bus, dispatcher, clawlessClient, cacheMgr)
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

func generateCerts(dir string) error {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create cert dir: %w", err)
	}

	caKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate CA key: %w", err)
	}

	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{Organization: []string{"AgentD"}, CommonName: "AgentD CA"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		IsCA:         true,
		MaxPathLen:   1,
		BasicConstraintsValid: true,
	}

	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return fmt.Errorf("create CA cert: %w", err)
	}
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

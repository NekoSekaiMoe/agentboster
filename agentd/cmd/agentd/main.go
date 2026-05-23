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
	"github.com/clawless/agentd/internal/security/l0_rules"
	"github.com/clawless/agentd/internal/server"
	"github.com/clawless/agentd/internal/worker"
	"github.com/gin-gonic/gin"
)

var (
	version   = "0.2.0"
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

	// Initialize L0 rules engine
	l0Engine := l0_rules.NewEngine()

	// Initialize sandbox manager
	sbManager := sandbox.NewManager(cfg)

	// Initialize ClawLess API client
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

	// Start L0 rules hot-reload loader
	l0Loader := l0_rules.NewLoader(l0Engine, clawlessClient, "default", 5*time.Minute)
	l0Loader.Start()
	defer l0Loader.Stop()

	// Initialize event bus + dispatcher
	bus := eventbus.New()
	dispatcher := worker.NewDispatcher(bus, config.NumCPU(), l0Engine, sbManager, clawlessClient)
	dispatcher.Start()
	defer dispatcher.Stop()

	// Local cache manager
	cacheMgr := cache.NewManager(cfg.Cache.Path, cfg.Cache.SessionMaxSize)
	if err := cacheMgr.Init(); err != nil {
		slog.Warn("cache init failed", "error", err)
	}
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
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create cert dir: %w", err)
	}

	// Generate CA key
	caKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate CA key: %w", err)
	}

	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization: []string{"AgentD"},
			CommonName:   "AgentD CA",
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
	}

	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return fmt.Errorf("create CA cert: %w", err)
	}
	caKeyDER, err := x509.MarshalECPrivateKey(caKey)
	if err != nil {
		return fmt.Errorf("marshal CA key: %w", err)
	}

	if err := writePEM(dir, "ca-cert.pem", "CERTIFICATE", caDER); err != nil {
		return err
	}
	if err := writePEM(dir, "ca-key.pem", "EC PRIVATE KEY", caKeyDER); err != nil {
		return err
	}

	// Generate server cert
	serverKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate server key: %w", err)
	}

	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject: pkix.Name{
			Organization: []string{"AgentD"},
			CommonName:   "agentd-server",
		},
		NotBefore:   time.Now(),
		NotAfter:    time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		DNSNames:    []string{"localhost", "agentd-server"},
	}

	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caTemplate, &serverKey.PublicKey, caKey)
	if err != nil {
		return fmt.Errorf("create server cert: %w", err)
	}
	serverKeyDER, err := x509.MarshalECPrivateKey(serverKey)
	if err != nil {
		return fmt.Errorf("marshal server key: %w", err)
	}

	if err := writePEM(dir, "server-cert.pem", "CERTIFICATE", serverDER); err != nil {
		return err
	}
	if err := writePEM(dir, "server-key.pem", "EC PRIVATE KEY", serverKeyDER); err != nil {
		return err
	}

	// Generate client cert
	clientKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate client key: %w", err)
	}

	clientTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(3),
		Subject: pkix.Name{
			Organization: []string{"AgentD"},
			CommonName:   "agentd-client",
		},
		NotBefore:   time.Now(),
		NotAfter:    time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}

	clientDER, err := x509.CreateCertificate(rand.Reader, clientTemplate, caTemplate, &clientKey.PublicKey, caKey)
	if err != nil {
		return fmt.Errorf("create client cert: %w", err)
	}
	clientKeyDER, err := x509.MarshalECPrivateKey(clientKey)
	if err != nil {
		return fmt.Errorf("marshal client key: %w", err)
	}

	if err := writePEM(dir, "client-cert.pem", "CERTIFICATE", clientDER); err != nil {
		return err
	}
	if err := writePEM(dir, "client-key.pem", "EC PRIVATE KEY", clientKeyDER); err != nil {
		return err
	}

	fmt.Printf("Generated mTLS certificates in %s:\n", dir)
	fmt.Println("  ca-cert.pem       — CA certificate (trust this on both sides)")
	fmt.Println("  ca-key.pem        — CA private key (keep secure)")
	fmt.Println("  server-cert.pem   — Server certificate")
	fmt.Println("  server-key.pem    — Server private key")
	fmt.Println("  client-cert.pem   — Client certificate (for ClawLess → Daemon)")
	fmt.Println("  client-key.pem    — Client private key")
	return nil
}

func writePEM(dir, filename, typ string, der []byte) error {
	path := dir + "/" + filename
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	return pem.Encode(f, &pem.Block{Type: typ, Bytes: der})
}

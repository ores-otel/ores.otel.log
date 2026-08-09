#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const CONTRACT_VERSION = '1.0.0';
const DEFAULT_IGNORES = new Set([
  '.git', '.github', '.dart_tool', '.gleam', '.idea', '.next', '.turbo',
  '.venv', '.zed', 'build', 'coverage', 'dist', 'node_modules', 'target',
  'vendor', 'venv',
]);

const LANGUAGE_RULES = {
  node: {
    manifests: ['package.json'],
    extensions: ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'],
    server: [
      /\bcreateServer\s*\(/,
      /\b(?:app|server|fastify)\.listen\s*\(/,
      /\bBun\.serve\s*\(/,
      /\bDeno\.serve\s*\(/,
      /\bnew\s+WebSocketServer\s*\(/,
    ],
    checks: {
      sigint: [/['"]SIGINT['"]/],
      sigterm: [/['"]SIGTERM['"]/],
      graceful: [/\.close\s*\(/, /closeIdleConnections\s*\(/],
      force: [/closeAllConnections\s*\(/, /destroy\s*\(/, /terminate\s*\(/],
      tty: [/\.isTTY\b/, /isatty/i],
      stdinEof: [/process\.stdin\.(?:once|on)\s*\(\s*['"](?:end|close)['"]/, /for\s+await\s*\([^)]*process\.stdin/],
      timeout: [/setTimeout\s*\(/, /AbortSignal\.timeout\s*\(/],
      flush: [/\bflush\s*\(/, /forceFlush\s*\(/, /shutdown\s*\(.*(?:logger|tracer|meter)/is],
      context: [/AsyncLocalStorage/, /execution[-_ ]context/i, /getActiveSpan\s*\(/, /trace\.getActiveSpan\s*\(/],
    },
  },
  go: {
    manifests: ['go.mod'],
    extensions: ['.go'],
    server: [
      /http\.ListenAndServe(?:TLS)?\s*\(/,
      /\b(?:http\.)?Server\s*\{/,
      /\.Serve\s*\(\s*listener/,
      /grpc\.NewServer\s*\(/,
    ],
    checks: {
      sigint: [/os\.Interrupt/, /syscall\.SIGINT/, /signal\.NotifyContext\s*\(/],
      sigterm: [/syscall\.SIGTERM/, /unix\.SIGTERM/],
      graceful: [/\.Shutdown\s*\(/, /GracefulStop\s*\(/],
      force: [/\.Close\s*\(/, /\.Stop\s*\(/],
      tty: [/term\.IsTerminal\s*\(/, /isatty\.IsTerminal\s*\(/, /ModeCharDevice/],
      stdinEof: [/io\.EOF/, /os\.Stdin/, /bufio\.NewReader\s*\(\s*os\.Stdin/],
      timeout: [/context\.WithTimeout\s*\(/, /time\.NewTimer\s*\(/, /time\.After\s*\(/],
      flush: [/\bFlush\s*\(/, /ForceFlush\s*\(/, /\b(?:tracer|meter|logger|telemetry|provider)\w*\.Shutdown\s*\(/i],
      context: [/context\.Context/, /context\.WithValue\s*\(/, /otel\./, /trace\.SpanFromContext\s*\(/],
    },
  },
  rust: {
    manifests: ['Cargo.toml'],
    extensions: ['.rs'],
    server: [
      /axum::serve\s*\(/,
      /Server::bind\s*\(/,
      /HttpServer::new\s*\(/,
      /warp::serve\s*\(/,
      /tonic::transport::Server/,
      /TcpListener::bind\s*\(/,
    ],
    checks: {
      sigint: [/signal::ctrl_c\s*\(/, /SignalKind::interrupt\s*\(/],
      sigterm: [/SignalKind::terminate\s*\(/, /SIGTERM/],
      graceful: [/with_graceful_shutdown\s*\(/, /graceful_shutdown\s*\(/, /CancellationToken/],
      force: [/\.abort\s*\(/, /abort_all\s*\(/, /force.*shutdown/is],
      tty: [/IsTerminal/, /atty::is\s*\(/],
      stdinEof: [/stdin\s*\(\s*\).*read/, /read_line\s*\(/, /AsyncReadExt/],
      timeout: [/timeout\s*\(/, /sleep\s*\(/, /CancellationToken/],
      flush: [/force_flush\s*\(/, /shutdown_tracer_provider\s*\(/, /shutdown_logger_provider\s*\(/],
      context: [/task_local!/, /thread_local!/, /tracing::Span/, /OpenTelemetrySpanExt/, /Context::current\s*\(/],
    },
  },
  gleam: {
    manifests: ['gleam.toml'],
    extensions: ['.gleam', '.erl'],
    server: [
      /mist\.(?:new|start_http|start_https)/,
      /wisp\./,
      /gleam_http/,
      /supervisor\.start\s*\(/,
      /gen_server/,
    ],
    checks: {
      sigint: [/SIGINT/, /interrupt/, /erl_signal_server/, /init:stop\s*\(/],
      sigterm: [/SIGTERM/, /terminate\s*\(/, /shutdown/],
      graceful: [/supervisor/, /shutdown/, /mist\.stop/, /init:stop\s*\(/],
      force: [/erlang:halt\s*\(/, /process\.kill\s*\(/, /exit\s*\([^,]+,\s*kill/],
      tty: [/isatty/i, /terminal/i, /io:columns\s*\(/],
      stdinEof: [/eof/, /standard_input/, /io:get_line\s*\(/],
      timeout: [/process\.send_after\s*\(/, /timer:sleep\s*\(/, /receive[\s\S]*after/],
      flush: [/force_flush/, /shutdown.*tracer/is, /opentelemetry/],
      context: [/process\.put\s*\(/, /process\.get\s*\(/, /erlang:put\s*\(/, /erlang:get\s*\(/, /opentelemetry/],
    },
  },
  dart: {
    manifests: ['pubspec.yaml'],
    extensions: ['.dart'],
    server: [
      /HttpServer\.bind(?:Secure)?\s*\(/,
      /shelf_io\.serve\s*\(/,
      /Server\s*\([^)]*\)\.serve\s*\(/,
      /grpc\.Server\s*\(/,
    ],
    checks: {
      sigint: [/ProcessSignal\.sigint/],
      sigterm: [/ProcessSignal\.sigterm/],
      graceful: [/\.close\s*\(\s*force:\s*false/, /\.shutdown\s*\(/],
      force: [/\.close\s*\(\s*force:\s*true/, /\.terminate\s*\(/, /\.kill\s*\(/],
      tty: [/(?:stdin|stdout|stderr)\.hasTerminal/],
      stdinEof: [/stdin\.(?:listen|transform)/, /await\s+for\s*\([^)]*stdin/],
      timeout: [/\.timeout\s*\(/, /Timer\s*\(/, /Future\.delayed\s*\(/],
      flush: [/\bflush\s*\(/, /forceFlush\s*\(/, /shutdown\s*\(/],
      context: [/Zone\.current/, /runZoned/, /Context\.current/, /opentelemetry/i],
    },
  },
};

function parseArgs(argv) {
  const options = { roots: [], format: 'markdown', output: null, strict: false };
  for (const arg of argv) {
    if (arg === '--strict') options.strict = true;
    else if (arg.startsWith('--format=')) options.format = arg.slice('--format='.length);
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else options.roots.push(arg);
  }
  if (options.roots.length === 0) options.roots.push('.');
  if (!['json', 'markdown'].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`);
  }
  return options;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORES.has(entry.name)) await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  await walk(root);
  return files;
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function evidenceFor(textByFile, patterns, limit = 8) {
  const evidence = [];
  for (const [file, text] of textByFile) {
    if (matchesAny(text, patterns)) evidence.push(file);
    if (evidence.length >= limit) break;
  }
  return evidence;
}

function riskFor(serverDetected, checks) {
  if (!serverDetected) return 'not-a-server';
  const critical = ['sigint', 'sigterm', 'graceful', 'force', 'timeout', 'context'];
  const missingCritical = critical.filter((key) => !checks[key]);
  if (missingCritical.length >= 3 || !checks.graceful || !checks.force) return 'high';
  if (missingCritical.length > 0 || !checks.tty || !checks.stdinEof || !checks.flush) return 'medium';
  return 'low';
}

async function auditRoot(inputRoot) {
  const root = path.resolve(inputRoot);
  const files = await collectFiles(root);
  const relative = (file) => path.relative(root, file) || '.';
  const result = {
    root,
    contractVersion: CONTRACT_VERSION,
    languages: {},
    serverDetected: false,
    risk: 'not-a-server',
    missing: [],
  };

  for (const [language, rule] of Object.entries(LANGUAGE_RULES)) {
    const manifestEvidence = [];
    for (const manifest of rule.manifests) {
      const candidate = path.join(root, manifest);
      if (await exists(candidate)) manifestEvidence.push(manifest);
    }

    const candidateFiles = files.filter((file) => rule.extensions.includes(path.extname(file)));
    if (manifestEvidence.length === 0 && candidateFiles.length === 0) continue;

    const textByFile = new Map();
    for (const file of candidateFiles) {
      try {
        const stat = await fs.stat(file);
        if (stat.size > 2_000_000) continue;
        textByFile.set(relative(file), await fs.readFile(file, 'utf8'));
      } catch {
        // A concurrently removed/generated file should not abort the full audit.
      }
    }

    const serverEvidence = evidenceFor(textByFile, rule.server);
    const checks = {};
    const checkEvidence = {};
    for (const [check, patterns] of Object.entries(rule.checks)) {
      const evidence = evidenceFor(textByFile, patterns);
      checks[check] = evidence.length > 0;
      checkEvidence[check] = evidence;
    }

    const serverDetected = serverEvidence.length > 0;
    const languageMissing = serverDetected
      ? Object.entries(checks).filter(([, present]) => !present).map(([name]) => name)
      : [];

    result.languages[language] = {
      manifests: manifestEvidence,
      sourceFileCount: textByFile.size,
      serverDetected,
      serverEvidence,
      checks,
      checkEvidence,
      missing: languageMissing,
      risk: riskFor(serverDetected, checks),
    };
    result.serverDetected ||= serverDetected;
  }

  const serverLanguages = Object.entries(result.languages)
    .filter(([, value]) => value.serverDetected);
  result.missing = [...new Set(serverLanguages.flatMap(([, value]) => value.missing))].sort();
  if (serverLanguages.some(([, value]) => value.risk === 'high')) result.risk = 'high';
  else if (serverLanguages.some(([, value]) => value.risk === 'medium')) result.risk = 'medium';
  else if (serverLanguages.length > 0) result.risk = 'low';
  return result;
}

function markdownReport(report) {
  const lines = [
    '# Server lifecycle and context audit',
    '',
    `Contract version: \`${report.contractVersion}\``,
    '',
    '| Repository root | Server languages | Risk | Missing capabilities |',
    '|---|---|---:|---|',
  ];

  for (const repository of report.repositories) {
    const languages = Object.entries(repository.languages)
      .filter(([, value]) => value.serverDetected)
      .map(([language]) => language)
      .join(', ') || 'none detected';
    lines.push(`| \`${repository.root}\` | ${languages} | **${repository.risk}** | ${repository.missing.join(', ') || 'none'} |`);
  }

  for (const repository of report.repositories) {
    lines.push('', `## ${repository.root}`, '');
    if (!repository.serverDetected) {
      lines.push('No supported server entry point was detected.');
      continue;
    }
    for (const [language, value] of Object.entries(repository.languages)) {
      if (!value.serverDetected) continue;
      lines.push(`### ${language}`, '');
      lines.push(`Risk: **${value.risk}**`);
      lines.push(`Server evidence: ${value.serverEvidence.map((file) => `\`${file}\``).join(', ') || 'none'}`);
      lines.push('', '| Capability | Present | Evidence |', '|---|---:|---|');
      for (const [check, present] of Object.entries(value.checks)) {
        const evidence = value.checkEvidence[check].map((file) => `\`${file}\``).join(', ');
        lines.push(`| ${check} | ${present ? 'yes' : 'no'} | ${evidence || '—'} |`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repositories = [];
  for (const root of options.roots) repositories.push(await auditRoot(root));
  const report = {
    schemaVersion: 1,
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    repositories,
    summary: {
      scanned: repositories.length,
      servers: repositories.filter((item) => item.serverDetected).length,
      highRisk: repositories.filter((item) => item.risk === 'high').length,
      mediumRisk: repositories.filter((item) => item.risk === 'medium').length,
      lowRisk: repositories.filter((item) => item.risk === 'low').length,
    },
  };

  const output = options.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : markdownReport(report);

  if (options.output) {
    await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await fs.writeFile(options.output, output);
  } else {
    process.stdout.write(output);
  }

  if (options.strict && repositories.some((item) => item.risk === 'high')) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

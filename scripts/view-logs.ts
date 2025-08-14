#!/usr/bin/env tsx
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

const logDir = process.env.LOG_DIR || './logs';

interface LogEntry {
  timestamp: string;
  level: string;
  service: string;
  message: string;
  correlationId?: string;
  requestId?: string;
  duration?: number;
  error?: string;
  stack?: string;
  metadata?: any;
}

function parseLogLine(line: string): LogEntry | null {
  try {
    return JSON.parse(line);
  } catch {
    // Handle non-JSON log lines
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[(\w+)\] \[([^\]]+)\] (.+)$/);
    if (match) {
      return {
        timestamp: match[1],
        level: match[2].toLowerCase(),
        service: match[3],
        message: match[4]
      };
    }
    return null;
  }
}

function formatLogEntry(entry: LogEntry): string {
  const levelColors: Record<string, string> = {
    fatal: '\x1b[31m\x1b[1m', // Red bold
    error: '\x1b[31m',         // Red
    warn: '\x1b[33m',          // Yellow
    info: '\x1b[32m',          // Green
    debug: '\x1b[34m',         // Blue
    trace: '\x1b[36m',         // Cyan
    verbose: '\x1b[35m'        // Magenta
  };
  
  const reset = '\x1b[0m';
  const color = levelColors[entry.level] || '';
  
  let output = `${entry.timestamp} ${color}[${entry.level.toUpperCase()}]${reset} [${entry.service}]`;
  
  if (entry.correlationId) {
    output += ` [CID:${entry.correlationId.substring(0, 8)}]`;
  }
  
  if (entry.requestId) {
    output += ` [RID:${entry.requestId.substring(0, 8)}]`;
  }
  
  if (entry.duration) {
    output += ` [${entry.duration}ms]`;
  }
  
  output += ` ${entry.message}`;
  
  if (entry.error) {
    output += `\n  ${color}ERROR: ${entry.error}${reset}`;
  }
  
  if (entry.stack && process.argv.includes('--stack')) {
    output += `\n  ${color}STACK:${reset}\n${entry.stack.split('\n').map(l => '    ' + l).join('\n')}`;
  }
  
  if (entry.metadata && process.argv.includes('--metadata')) {
    output += `\n  METADATA: ${JSON.stringify(entry.metadata, null, 2)}`;
  }
  
  return output;
}

function listLogFiles(): string[] {
  if (!existsSync(logDir)) {
    console.error(`Log directory not found: ${logDir}`);
    return [];
  }
  
  return readdirSync(logDir)
    .filter(file => file.endsWith('.log'))
    .map(file => join(logDir, file))
    .sort((a, b) => {
      const statA = statSync(a);
      const statB = statSync(b);
      return statB.mtime.getTime() - statA.mtime.getTime();
    });
}

function tailLog(file: string, lines: number = 50): void {
  if (!existsSync(file)) {
    console.error(`Log file not found: ${file}`);
    return;
  }
  
  const content = readFileSync(file, 'utf-8');
  const logLines = content.trim().split('\n');
  const startIndex = Math.max(0, logLines.length - lines);
  
  for (let i = startIndex; i < logLines.length; i++) {
    const entry = parseLogLine(logLines[i]);
    if (entry) {
      console.log(formatLogEntry(entry));
    }
  }
}

function filterLogs(file: string, filters: Record<string, any>): void {
  if (!existsSync(file)) {
    console.error(`Log file not found: ${file}`);
    return;
  }
  
  const rl = createInterface({
    input: require('fs').createReadStream(file),
    crlfDelay: Infinity
  });
  
  rl.on('line', (line) => {
    const entry = parseLogLine(line);
    if (!entry) return;
    
    let match = true;
    
    if (filters.level && entry.level !== filters.level) {
      match = false;
    }
    
    if (filters.service && !entry.service.includes(filters.service)) {
      match = false;
    }
    
    if (filters.correlationId && entry.correlationId !== filters.correlationId) {
      match = false;
    }
    
    if (filters.search && !JSON.stringify(entry).includes(filters.search)) {
      match = false;
    }
    
    if (filters.error && !entry.error) {
      match = false;
    }
    
    if (match) {
      console.log(formatLogEntry(entry));
    }
  });
}

function showHelp(): void {
  console.log(`
MCP Feature Store - Log Viewer

Usage: npm run logs [command] [options]

Commands:
  list                List all log files
  tail [file]        Show last N lines of a log file (default: combined.log)
  filter [file]      Filter logs by criteria
  errors             Show only error logs
  verbose            Show verbose logs
  
Options:
  --lines N          Number of lines to show (default: 50)
  --level LEVEL      Filter by log level
  --service SERVICE  Filter by service name
  --cid ID          Filter by correlation ID
  --search TEXT     Search for text in logs
  --stack           Include stack traces
  --metadata        Include metadata
  
Examples:
  npm run logs tail error.log --lines 100
  npm run logs filter combined.log --level error --stack
  npm run logs filter debug.log --service orchestrator
  npm run logs errors --stack
  `);
}

// Main
const command = process.argv[2] || 'tail';

switch (command) {
  case 'help':
    showHelp();
    break;
    
  case 'list':
    const files = listLogFiles();
    if (files.length === 0) {
      console.log('No log files found');
    } else {
      console.log('Available log files:');
      files.forEach(file => {
        const stat = statSync(file);
        const size = (stat.size / 1024).toFixed(2);
        console.log(`  ${file} (${size} KB)`);
      });
    }
    break;
    
  case 'tail': {
    const file = process.argv[3] || join(logDir, 'combined.log');
    const linesArg = process.argv.indexOf('--lines');
    const lines = linesArg > -1 ? parseInt(process.argv[linesArg + 1]) : 50;
    tailLog(file, lines);
    break;
  }
    
  case 'filter': {
    const file = process.argv[3] || join(logDir, 'combined.log');
    const filters: Record<string, any> = {};
    
    const levelArg = process.argv.indexOf('--level');
    if (levelArg > -1) filters.level = process.argv[levelArg + 1];
    
    const serviceArg = process.argv.indexOf('--service');
    if (serviceArg > -1) filters.service = process.argv[serviceArg + 1];
    
    const cidArg = process.argv.indexOf('--cid');
    if (cidArg > -1) filters.correlationId = process.argv[cidArg + 1];
    
    const searchArg = process.argv.indexOf('--search');
    if (searchArg > -1) filters.search = process.argv[searchArg + 1];
    
    if (process.argv.includes('--error')) filters.error = true;
    
    filterLogs(file, filters);
    break;
  }
    
  case 'errors':
    filterLogs(join(logDir, 'error.log'), {});
    break;
    
  case 'verbose':
    tailLog(join(logDir, 'debug.log'), 100);
    break;
    
  default:
    console.error(`Unknown command: ${command}`);
    showHelp();
}
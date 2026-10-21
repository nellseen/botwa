#!/usr/bin/env node
// ===================================================
//  NellsBotBase - Complete Automated Testing Pipeline
//  Static -> Unit -> Integration -> E2E -> Load -> Build
// ===================================================

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const reportDir = path.join(__dirname, '../reports');
if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

console.log(chalk.bold.cyan('\n======================================================'));
console.log(chalk.bold.cyan('  NellsBotBase - Full Automated Quality Gate Pipeline '));
console.log(chalk.bold.cyan('======================================================\n'));

const pipelineResults = [];

function runStep(name, cmd) {
    console.log(chalk.bold.yellow(`\n[PIPELINE] Running: ${name}...`));
    const start = Date.now();
    try {
        const out = execSync(cmd, { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        console.log(chalk.bold.green(`✓ [PASSED] ${name} (${duration}s)`));
        pipelineResults.push({ name, status: 'PASSED', durationSeconds: parseFloat(duration) });
        return true;
    } catch (err) {
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        console.error(chalk.bold.red(`✗ [FAILED] ${name} (${duration}s)`));
        pipelineResults.push({ name, status: 'FAILED', durationSeconds: parseFloat(duration), error: err.message });
        return false;
    }
}

let allPassed = true;

// 1. Static Test
if (!runStep('1. Static Test (ESLint)', 'npx eslint index.js control/ core/ lib/ plugins/ telegram/ --quiet')) {
    allPassed = false;
}

// 2. Unit Test
if (allPassed && !runStep('2. Unit Test (Node Test Runner)', 'node --test tests/unit/*.test.js')) {
    allPassed = false;
}

// 3. Integration Test
if (allPassed && !runStep('3. Integration Test (API & Telegram Handlers)', 'node --test tests/integration/*.test.js')) {
    allPassed = false;
}

// 4. E2E Test
if (allPassed && !runStep('4. E2E Test (DOM & UI Lifecycle Automation)', 'node --test tests/e2e/*.test.js')) {
    allPassed = false;
}

// 5. Load Test
if (allPassed && !runStep('5. Load Test (Autocannon Throughput & Latency)', 'node --test tests/load/*.test.js')) {
    allPassed = false;
}

// 6. Build
if (allPassed && !runStep('6. Build & Compilation Verification', 'npm run build')) {
    allPassed = false;
}

const pipelineSummary = {
    timestamp: new Date().toISOString(),
    overallStatus: allPassed ? 'PASSED' : 'FAILED',
    stages: pipelineResults
};

fs.writeFileSync(path.join(reportDir, 'pipeline-summary.json'), JSON.stringify(pipelineSummary, null, 2));

console.log(chalk.bold.cyan('\n======================================================'));
if (allPassed) {
    console.log(chalk.bold.green('  ✓ ALL QUALITY GATES PASSED! App is 100% Ready.'));
    console.log(chalk.bold.cyan('======================================================\n'));
    process.exit(0);
} else {
    console.error(chalk.bold.red('  ✗ PIPELINE BLOCKED! One or more quality gates failed.'));
    console.log(chalk.bold.cyan('======================================================\n'));
    process.exit(1);
}

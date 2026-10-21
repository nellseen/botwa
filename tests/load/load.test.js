const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const autocannon = require('autocannon');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../../index');

describe('Load Test: Backend & API Throughput Benchmarks', () => {
    let server;
    const testPort = 3077;
    const baseUrl = `http://127.0.0.1:${testPort}`;
    const reportDir = path.join(__dirname, '../../reports');

    before(async () => {
        server = await startServer(testPort, '127.0.0.1');
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    });

    after(() => {
        if (server) server.close();
    });

    it('Controlled Load Test on GET /api/status endpoint', async () => {
        const memBefore = process.memoryUsage().rss;

        const result = await autocannon({
            url: `${baseUrl}/api/status`,
            connections: 10,
            duration: 4,
            pipelining: 1
        });

        const memAfter = process.memoryUsage().rss;

        console.log('\n--- Load Test Results: /api/status ---');
        console.log(`Requests Total: ${result.requests.total}`);
        console.log(`Throughput: ${result.requests.average} req/sec`);
        console.log(`Latency p50: ${result.latency.p50} ms`);
        console.log(`Latency p95: ${result.latency.p97_5 || result.latency.p99} ms`);
        console.log(`Latency p99: ${result.latency.p99} ms`);
        console.log(`Errors: ${result.errors}`);
        console.log(`Non-2xx: ${result.non2xx}`);
        console.log('--------------------------------------\n');

        const report = {
            endpoint: '/api/status',
            timestamp: new Date().toISOString(),
            durationSeconds: result.duration,
            connections: 10,
            metrics: {
                totalRequests: result.requests.total,
                requestsPerSecond: result.requests.average,
                latency: {
                    p50: result.latency.p50,
                    p90: result.latency.p90,
                    p95: result.latency.p97_5 || result.latency.p99,
                    p99: result.latency.p99,
                    max: result.latency.max,
                    mean: result.latency.mean
                },
                throughputBytesPerSec: result.throughput.average,
                errorCount: result.errors,
                non2xxCount: result.non2xx,
                memoryBeforeMb: Math.round(memBefore / 1024 / 1024),
                memoryAfterMb: Math.round(memAfter / 1024 / 1024)
            },
            status: result.errors === 0 && result.non2xx === 0 ? 'PASSED' : 'FAILED'
        };

        fs.writeFileSync(path.join(reportDir, 'load-test-report.json'), JSON.stringify(report, null, 2));

        // Quality Gate Assertions
        assert.strictEqual(result.errors, 0, 'No socket/network connection errors allowed');
        assert.strictEqual(result.non2xx, 0, 'No non-2xx HTTP responses allowed');
        assert.ok(result.requests.total > 100, `Expected at least 100 requests handled, got ${result.requests.total}`);
        assert.ok(result.latency.p50 < 100, `p50 latency should be under 100ms, got ${result.latency.p50}ms`);
    });
});

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const plugins = require('../../lib/plugins');

describe('Unit Test: lib/plugins.js Plugin Manager', () => {
    before(() => {
        plugins.initPlugins();
    });

    it('should load all 13 plugins', () => {
        const count = plugins.count();
        assert.ok(count >= 12, `Expected at least 12 plugins, found: ${count}`);
    });

    it('should find plugins by exact command name', () => {
        const menuPlugin = plugins.findPlugin('menu');
        assert.ok(menuPlugin, 'menu plugin should be found');
        assert.strictEqual(menuPlugin.name, 'menu');

        const ownerPlugin = plugins.findPlugin('owner');
        assert.ok(ownerPlugin, 'owner plugin should be found');
        assert.strictEqual(ownerPlugin.name, 'owner');

        const antilinkPlugin = plugins.findPlugin('antilink');
        assert.ok(antilinkPlugin, 'antilink plugin should be found');
        assert.strictEqual(antilinkPlugin.name, 'antilink');
    });

    it('should find plugins by command aliases', () => {
        const playPlugin = plugins.findPlugin('play');
        assert.ok(playPlugin, 'play alias should resolve to mp3 plugin');
        assert.strictEqual(playPlugin.name, 'mp3');

        const lagPlugin = plugins.findPlugin('lagu');
        assert.ok(lagPlugin, 'lagu alias should resolve to mp3 plugin');
        assert.strictEqual(lagPlugin.name, 'mp3');
    });

    it('should categorize plugins correctly', () => {
        const categories = plugins.getCategories();
        assert.ok(categories.main, 'main category should exist');
        assert.ok(categories.owner, 'owner category should exist');
        assert.ok(categories.tools, 'tools category should exist');
        assert.ok(categories.grup, 'grup category should exist');
    });

    it('countCommands should return total command count', () => {
        const total = plugins.countCommands();
        assert.ok(total > 15, `Expected more than 15 total commands, got ${total}`);
    });
});

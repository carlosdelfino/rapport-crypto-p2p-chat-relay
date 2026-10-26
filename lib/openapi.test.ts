import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const spec = JSON.parse(await readFile(new URL('../public/openapi.json', import.meta.url), 'utf8'));

test('RF-RELAY-09 OpenAPI references resolve and protected routes document refusal', () => {
  function inspect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === 'string') {
      assert.ok(object.$ref.startsWith('#/'));
      let target: any = spec;
      for (const key of object.$ref.slice(2).split('/')) target = target?.[key];
      assert.ok(target, object.$ref);
    }
    for (const item of Object.values(object)) inspect(item);
  }
  inspect(spec);
  for (const operations of Object.values(spec.paths) as Array<Record<string, any>>) {
    for (const operation of Object.values(operations)) {
      assert.ok(operation.responses['429']);
      assert.ok(operation.responses['503']);
      assert.match(operation.description, /Authentication:/);
      assert.match(operation.description, /[Aa]gent level:/);
      assert.match(operation.description, /[Hh]uman/);
    }
  }
  assert.equal(spec.components.schemas.OnrampInput.properties.assets.properties.tokens.maxItems, 16);
});

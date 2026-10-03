import assert from 'node:assert/strict';
import test from 'node:test';
import { receiptRateLimitKey } from '../worker/receipt-rate-limit';

test('IPv4 keeps its individual address quota', () => {
  for (const address of ['0.0.0.0', '192.0.2.1', '198.51.100.255', '255.255.255.255'])
    assert.equal(receiptRateLimitKey(address), `receipt-scan:${address}`);
  assert.notEqual(receiptRateLimitKey('192.0.2.1'), receiptRateLimitKey('192.0.2.2'));
});

test('compressed, expanded and uppercase IPv6 addresses share their /64 quota', () => {
  const addresses = [
    '2001:db8:1234:5678::1',
    '2001:0DB8:1234:5678:0000:0000:0000:0001',
    '2001:db8:1234:5678:abcd:ef01:2345:6789',
    '2001:db8:1234:5678:ffff:ffff:ffff:ffff',
    '2001:db8:1234:5678::192.0.2.1',
  ];
  for (const address of addresses)
    assert.equal(receiptRateLimitKey(address), 'receipt-scan:2001:db8:1234:5678::/64');
  assert.notEqual(
    receiptRateLimitKey('2001:db8:1234:5678::1'),
    receiptRateLimitKey('2001:db8:1234:5679::1'),
  );
});

test('compression across the prefix boundary yields a stable /64', () => {
  for (const address of ['2001:db8::1', '2001:0db8:0000:0000:0:0:0:1', '2001:db8:0:0:ffff::'])
    assert.equal(receiptRateLimitKey(address), 'receipt-scan:2001:db8:0:0::/64');
  for (const address of ['::', '::1', '0:0:0:0:0:0:0:1', '::192.0.2.1'])
    assert.equal(receiptRateLimitKey(address), 'receipt-scan:0:0:0:0::/64');
  assert.equal(
    receiptRateLimitKey('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'),
    'receipt-scan:ffff:ffff:ffff:ffff::/64',
  );
});

test('IPv4-mapped IPv6 cannot create a second quota for the same IPv4 address', () => {
  for (const address of [
    '::ffff:192.0.2.1',
    '::FFFF:C000:0201',
    '0:0:0:0:0:ffff:c000:201',
    '0000:0000:0000:0000:0000:ffff:192.0.2.1',
  ])
    assert.equal(receiptRateLimitKey(address), receiptRateLimitKey('192.0.2.1'));
  assert.equal(receiptRateLimitKey('::ffff:0:0'), receiptRateLimitKey('0.0.0.0'));
  assert.equal(receiptRateLimitKey('::ffff:ffff:ffff'), receiptRateLimitKey('255.255.255.255'));
  assert.notEqual(receiptRateLimitKey('::ffff:0:192.0.2.1'), receiptRateLimitKey('192.0.2.1'));
});

test('missing and invalid addresses share a safe fallback instead of attacker-selected buckets', () => {
  const invalid = [
    undefined,
    null,
    '',
    ' ',
    'unknown',
    'example.com',
    '127.1',
    '2130706433',
    '0x7f000001',
    '192.168.001.1',
    '256.0.0.1',
    '-1.0.0.1',
    '1.2.3.4.5',
    '192.0.2.1:443',
    '192.0.2.1\n',
    '[2001:db8::1]',
    '[2001:db8::1]:443',
    '2001:db8::1/64',
    'fe80::1%eth0',
    '2001:db8:::1',
    '2001::db8::1',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7:8::',
    '10000::',
    'gggg::1',
    '::ffff:192.0.2.999',
    '::ffff:192.0.002.1',
    '::ffff:192.0.2',
    '2001:db8:192.0.2.1::1',
    '2001:db8::1]@evil.test',
    '1'.repeat(1000),
  ];
  for (const address of invalid)
    assert.equal(receiptRateLimitKey(address), 'receipt-scan:unknown', String(address));
});

test('rotating IPv6 interface identifiers cannot bypass a six-request quota', () => {
  const counts = new Map<string, number>();
  const allow = (address: string) => {
    const key = receiptRateLimitKey(address);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count <= 6;
  };
  const accepted = Array.from({ length: 16 }, (_, index) =>
    allow(`2001:db8:1234:5678::${(index + 1).toString(16)}`),
  );
  assert.equal(accepted.filter(Boolean).length, 6);
  assert.equal(counts.size, 1);
  assert.equal(allow('2001:db8:1234:5679::1'), true);
});

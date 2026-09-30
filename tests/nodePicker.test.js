'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasNodeSelection, pickRequestedNode, pickNode } = require('../src/control/nodePicker');

// ========== hasNodeSelection ==========

test('hasNodeSelection：空参数返回 false', () => {
  assert.equal(hasNodeSelection(), false);
  assert.equal(hasNodeSelection({}), false);
  assert.equal(hasNodeSelection({ nodeId: '', relayAddr: '' }), false);
});

test('hasNodeSelection：仅 nodeId 返回 true', () => {
  assert.equal(hasNodeSelection({ nodeId: 'node-1' }), true);
  assert.equal(hasNodeSelection({ nodeId: '  node-1  ' }), true);
});

test('hasNodeSelection：仅 relayAddr 返回 true', () => {
  assert.equal(hasNodeSelection({ relayAddr: '1.2.3.4' }), true);
});

test('hasNodeSelection：两者都有返回 true', () => {
  assert.equal(hasNodeSelection({ nodeId: 'node-1', relayAddr: '1.2.3.4' }), true);
});

test('hasNodeSelection：非字符串值忽略', () => {
  assert.equal(hasNodeSelection({ nodeId: 123, relayAddr: null }), false);
  assert.equal(hasNodeSelection({ nodeId: undefined, relayAddr: undefined }), false);
});

// ========== pickRequestedNode ==========

test('pickRequestedNode：空节点列表返回 null', () => {
  assert.equal(pickRequestedNode([], { nodeId: 'node-1' }), null);
  assert.equal(pickRequestedNode(null, { nodeId: 'node-1' }), null);
});

test('pickRequestedNode：按 nodeId 精确匹配', () => {
  const nodes = [
    { id: 'node-1', addr: '1.1.1.1', tunnelPort: 20000 },
    { id: 'node-2', addr: '2.2.2.2', tunnelPort: 20000 }
  ];
  assert.equal(pickRequestedNode(nodes, { nodeId: 'node-2' }).id, 'node-2');
});

test('pickRequestedNode：nodeId 不匹配返回 null', () => {
  const nodes = [{ id: 'node-1', addr: '1.1.1.1', tunnelPort: 20000 }];
  assert.equal(pickRequestedNode(nodes, { nodeId: 'node-999' }), null);
});

test('pickRequestedNode：按 relayAddr 匹配（单节点同地址）', () => {
  const nodes = [
    { id: 'node-1', addr: '1.2.3.4', tunnelPort: 20000 },
    { id: 'node-2', addr: '5.6.7.8', tunnelPort: 20000 }
  ];
  assert.equal(pickRequestedNode(nodes, { relayAddr: '1.2.3.4' }).id, 'node-1');
});

test('pickRequestedNode：按 relayAddr 匹配（多节点同地址，无 tunnelPort → 歧义返回 null）', () => {
  const nodes = [
    { id: 'node-1', addr: '1.2.3.4', tunnelPort: 20000 },
    { id: 'node-2', addr: '1.2.3.4', tunnelPort: 20001 }
  ];
  assert.equal(pickRequestedNode(nodes, { relayAddr: '1.2.3.4' }), null);
});

test('pickRequestedNode：按 relayAddr + relayTunnelPort 精确匹配', () => {
  const nodes = [
    { id: 'node-1', addr: '1.2.3.4', tunnelPort: 20000 },
    { id: 'node-2', addr: '1.2.3.4', tunnelPort: 20001 }
  ];
  assert.equal(pickRequestedNode(nodes, { relayAddr: '1.2.3.4', relayTunnelPort: 20001 }).id, 'node-2');
});

test('pickRequestedNode：relayTunnelPort 字符串解析', () => {
  const nodes = [
    { id: 'node-1', addr: '1.2.3.4', tunnelPort: 20000 },
    { id: 'node-2', addr: '1.2.3.4', tunnelPort: 20001 }
  ];
  assert.equal(pickRequestedNode(nodes, { relayAddr: '1.2.3.4', relayTunnelPort: '20000' }).id, 'node-1');
});

test('pickRequestedNode：relayTunnelPort 无效时按无 tunnelPort 处理（单节点匹配）', () => {
  const nodes = [{ id: 'node-1', addr: '1.2.3.4', tunnelPort: 20000 }];
  // 无效 tunnelPort 回退到"不指定 tunnelPort"逻辑 → 单节点同地址可匹配
  assert.equal(pickRequestedNode(nodes, { relayAddr: '1.2.3.4', relayTunnelPort: 'abc' }).id, 'node-1');
  assert.equal(pickRequestedNode(nodes, { relayAddr: '1.2.3.4', relayTunnelPort: 0 }).id, 'node-1');
});

test('pickRequestedNode：relayTunnelPort 无效 + 多节点同地址返回 null（歧义）', () => {
  const nodes = [
    { id: 'node-1', addr: '1.2.3.4', tunnelPort: 20000 },
    { id: 'node-2', addr: '1.2.3.4', tunnelPort: 20001 }
  ];
  assert.equal(pickRequestedNode(nodes, { relayAddr: '1.2.3.4', relayTunnelPort: -1 }), null);
});

test('pickRequestedNode：relayAddr 无匹配返回 null', () => {
  const nodes = [{ id: 'node-1', addr: '1.2.3.4', tunnelPort: 20000 }];
  assert.equal(pickRequestedNode(nodes, { relayAddr: '9.9.9.9' }), null);
});

test('pickRequestedNode：空白字符串视为未指定', () => {
  const nodes = [{ id: 'node-1', addr: '1.2.3.4', tunnelPort: 20000 }];
  assert.equal(pickRequestedNode(nodes, { nodeId: '  ', relayAddr: '' }), null);
});

// ========== pickNode ==========

test('pickNode：空数组返回 null', () => {
  assert.equal(pickNode([]), null);
  assert.equal(pickNode(null), null);
});

test('pickNode：单节点直接返回', () => {
  const nodes = [{ id: 'only-one', stats: { sessions: 10, rooms: 5, mbpsUsed: 100 } }];
  assert.equal(pickNode(nodes).id, 'only-one');
});

test('pickNode：两个节点选负载较低的', () => {
  const nodes = [
    { id: 'heavy', stats: { sessions: 100, rooms: 50, mbpsUsed: 50 } },
    { id: 'light', stats: { sessions: 1, rooms: 1, mbpsUsed: 1 } }
  ];
  assert.equal(pickNode(nodes).id, 'light');
});

test('pickNode：负载全部为零仍稳定选择', () => {
  const nodes = [
    { id: 'first', stats: { sessions: 0, rooms: 0, mbpsUsed: 0 } },
    { id: 'second', stats: { sessions: 0, rooms: 0, mbpsUsed: 0 } }
  ];
  const result = pickNode(nodes);
  assert.ok(result);
  assert.ok(['first', 'second'].includes(result.id));
});

test('pickNode：stats 缺失的节点视为零负载', () => {
  const nodes = [
    { id: 'no-stats' },
    { id: 'heavy', stats: { sessions: 100, rooms: 50, mbpsUsed: 50 } }
  ];
  assert.equal(pickNode(nodes).id, 'no-stats');
});

test('pickNode：不修改原数组', () => {
  const nodes = [
    { id: 'b', stats: { sessions: 10, rooms: 5, mbpsUsed: 5 } },
    { id: 'a', stats: { sessions: 1, rooms: 1, mbpsUsed: 1 } }
  ];
  const original = [...nodes];
  pickNode(nodes);
  assert.deepEqual(nodes.map(n => n.id), original.map(n => n.id));
});

test('pickNode：三个节点综合排序', () => {
  const nodes = [
    { id: 'high-sessions', stats: { sessions: 90, rooms: 1, mbpsUsed: 1 } },
    { id: 'high-rooms', stats: { sessions: 1, rooms: 40, mbpsUsed: 1 } },
    { id: 'balanced', stats: { sessions: 5, rooms: 3, mbpsUsed: 2 } }
  ];
  // balanced 综合得分最低
  assert.equal(pickNode(nodes).id, 'balanced');
});

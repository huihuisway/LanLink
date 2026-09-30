'use strict';

function parseNodeAccessConfig(raw) {
  if (!raw) return { defaultAccess: 'login', nodes: {} };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return normalizeConfig(parsed);
  } catch {
    return { defaultAccess: 'login', nodes: {} };
  }
}

function normalizeConfig(config = {}) {
  const defaultAccess = normalizeAccess(config.default_access || config.defaultAccess || 'login');
  const nodes = {};
  for (const [id, value] of Object.entries(config.nodes || {})) {
    nodes[id] = {
      access: normalizeAccess(value.access || defaultAccess),
      roles: Array.isArray(value.roles) ? value.roles.map(String) : [],
      tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
      region: value.region ? String(value.region) : '',
      description: value.description ? String(value.description) : ''
    };
  }
  return { defaultAccess, nodes };
}

function normalizeAccess(value) {
  return value === 'login' ? 'login' : 'anonymous';
}

function nodePolicy(node, config = {}) {
  const policies = config.nodes || {};
  const explicit = policies[node.id] || {};
  // 控制面配置优先；否则使用节点自己上报的 requiresLogin
  let access;
  if (explicit.access) {
    access = normalizeAccess(explicit.access);
  } else if (config.defaultAccess) {
    access = normalizeAccess(config.defaultAccess);
  } else {
    access = node.requiresLogin ? 'login' : 'anonymous';
  }
  return {
    access,
    roles: explicit.roles || [],
    tags: explicit.tags || [],
    region: explicit.region || node.region || '',
    description: explicit.description || node.description || ''
  };
}

function canUseNode(node, user, config = {}) {
  const policy = nodePolicy(node, config);
  if (policy.access === 'anonymous') return { usable: true, reason: '', policy };
  if (!user) return { usable: false, reason: 'login_required', policy };
  if (policy.roles.length > 0) {
    const roles = new Set([...(user.roles || []), user.role].filter(Boolean).map(String));
    const allowed = policy.roles.some((role) => roles.has(role));
    if (!allowed) return { usable: false, reason: 'role_required', policy };
  }
  return { usable: true, reason: '', policy };
}

function filterUsableNodes(nodes, user, config = {}) {
  return (nodes || []).filter((node) => canUseNode(node, user, config).usable);
}

module.exports = { parseNodeAccessConfig, nodePolicy, canUseNode, filterUsableNodes };

import type { ESLint, Linter, Rule } from 'eslint';

type AstNode = Rule.Node & {
  argument?: Rule.Node;
  callee?: Rule.Node;
  computed?: boolean;
  expression?: Rule.Node;
  id?: Rule.Node;
  imported?: Rule.Node & { name?: string; value?: unknown };
  init?: Rule.Node | null;
  left?: Rule.Node;
  local?: Rule.Node & { name?: string };
  name?: string;
  object?: Rule.Node;
  property?: Rule.Node & { name?: string; value?: unknown };
  right?: Rule.Node;
  source?: { value?: unknown };
  specifiers?: Rule.Node[];
  value?: unknown;
};

export interface RequireSendRuleOptions {
  /** Extra variable or property paths that hold logger instances. */
  loggerNames?: string[];
  /** Extra package names that export next-loggers-compatible factories. */
  moduleNames?: string[];
}

const LEVEL_METHODS = new Set(['trace', 'debug', 'info', 'log', 'warn', 'error', 'fatal']);
const LOGGER_EXPORTS = new Set([
  'logger',
  'browserLogger',
  'edgeLogger',
  'cloudflareWorkerLogger',
  'nodeLogger',
  'bunLogger',
  'denoLogger',
]);
const FACTORY_EXPORTS = new Set([
  'createLogger',
  'createBrowserLogger',
  'createEdgeLogger',
  'createCloudflareWorkerLogger',
  'createNodeLogger',
  'createBunLogger',
  'createDenoLogger',
]);
const CLASS_EXPORTS = new Set([
  'BaseLogger',
  'BrowserLogger',
  'EdgeLogger',
  'CloudflareWorkerLogger',
  'NodeLogger',
  'BunLogger',
  'DenoLogger',
]);

function hasType(node: Rule.Node | null | undefined, ...types: string[]): boolean {
  return Boolean(node && types.includes(String(node.type)));
}

function unwrap(node: Rule.Node | null | undefined): AstNode | undefined {
  let current = node as AstNode | null | undefined;
  while (
    current &&
    (hasType(
      current,
      'ChainExpression',
      'AwaitExpression',
      'TSAsExpression',
      'TSTypeAssertion',
    ) ||
      (current.type === 'UnaryExpression' && current.operator === 'void'))
  ) {
    current = (current.expression || current.argument) as AstNode | undefined;
  }
  return current || undefined;
}

function getPropertyName(node: AstNode): string | undefined {
  if (!hasType(node, 'MemberExpression', 'OptionalMemberExpression')) {
    return undefined;
  }
  const property = node.property as AstNode | undefined;
  if (!property) {
    return undefined;
  }
  if (!node.computed && property.type === 'Identifier') {
    return property.name;
  }
  if (node.computed && property.type === 'Literal' && typeof property.value === 'string') {
    return property.value;
  }
  return undefined;
}

function getQualifiedName(node: Rule.Node | null | undefined): string | undefined {
  const current = unwrap(node);
  if (!current) {
    return undefined;
  }
  if (current.type === 'Identifier') {
    return current.name;
  }
  if (current.type === 'ThisExpression') {
    return 'this';
  }
  if (hasType(current, 'MemberExpression', 'OptionalMemberExpression')) {
    const objectName = getQualifiedName(current.object);
    const propertyName = getPropertyName(current);
    return objectName && propertyName ? `${objectName}.${propertyName}` : undefined;
  }
  return undefined;
}

function collectCallChain(
  node: Rule.Node | null | undefined,
  methods: string[],
): string | undefined {
  const current = unwrap(node);
  if (!current) {
    return undefined;
  }
  if (hasType(current, 'CallExpression', 'OptionalCallExpression')) {
    const callee = unwrap(current.callee);
    if (callee && hasType(callee, 'MemberExpression', 'OptionalMemberExpression')) {
      const root = collectCallChain(callee.object, methods);
      const method = getPropertyName(callee);
      if (method) {
        methods.push(method);
      }
      return root;
    }
    return getQualifiedName(callee);
  }
  return getQualifiedName(current);
}

function isNextLoggersModule(source: unknown, moduleNames: Set<string>): source is string {
  if (typeof source !== 'string') {
    return false;
  }
  for (const moduleName of moduleNames) {
    if (source === moduleName || source.startsWith(`${moduleName}/`)) {
      return true;
    }
  }
  return false;
}

export const requireSendRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'require chainable next-loggers events to call send()',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          loggerNames: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          moduleNames: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingSend: 'Call .send() on this log event so it is delivered before shutdown.',
    },
  },

  create(context) {
    const options = (context.options[0] || {}) as RequireSendRuleOptions;
    const knownLoggers = new Set(['log', 'logger', 'ddlog', ...(options.loggerNames || [])]);
    const knownFactories = new Set<string>();
    const knownClasses = new Set<string>();
    const moduleNames = new Set(['@oresoftware/next-loggers', ...(options.moduleNames || [])]);

    const isLoggerProducer = (node: Rule.Node | null | undefined): boolean => {
      const current = unwrap(node);
      if (!current) {
        return false;
      }
      const directName = getQualifiedName(current);
      if (directName && knownLoggers.has(directName)) {
        return true;
      }
      if (current.type === 'NewExpression') {
        const className = getQualifiedName(current.callee);
        return Boolean(className && knownClasses.has(className));
      }
      if (hasType(current, 'CallExpression', 'OptionalCallExpression')) {
        const calleeName = getQualifiedName(current.callee);
        if (calleeName && knownFactories.has(calleeName)) {
          return true;
        }
        const callee = unwrap(current.callee);
        if (callee && hasType(callee, 'MemberExpression', 'OptionalMemberExpression')) {
          const method = getPropertyName(callee);
          const owner = getQualifiedName(callee.object);
          return method === 'anew' && Boolean(owner && knownLoggers.has(owner));
        }
      }
      return false;
    };

    return {
      ImportDeclaration(node: Rule.Node): void {
        const declaration = node as AstNode;
        if (!isNextLoggersModule(declaration.source?.value, moduleNames)) {
          return;
        }
        for (const rawSpecifier of declaration.specifiers || []) {
          const specifier = rawSpecifier as AstNode;
          const localName = specifier.local?.name;
          if (!localName) {
            continue;
          }
          if (specifier.type === 'ImportDefaultSpecifier') {
            knownLoggers.add(localName);
            continue;
          }
          if (specifier.type === 'ImportNamespaceSpecifier') {
            for (const name of LOGGER_EXPORTS) knownLoggers.add(`${localName}.${name}`);
            for (const name of FACTORY_EXPORTS) knownFactories.add(`${localName}.${name}`);
            for (const name of CLASS_EXPORTS) knownClasses.add(`${localName}.${name}`);
            continue;
          }
          const importedName = specifier.imported?.name || specifier.imported?.value;
          if (typeof importedName !== 'string') {
            continue;
          }
          if (LOGGER_EXPORTS.has(importedName)) knownLoggers.add(localName);
          if (FACTORY_EXPORTS.has(importedName)) knownFactories.add(localName);
          if (CLASS_EXPORTS.has(importedName)) knownClasses.add(localName);
        }
      },

      VariableDeclarator(node: Rule.Node): void {
        const declaration = node as AstNode;
        const identifier = declaration.id as AstNode | undefined;
        if (identifier?.type === 'Identifier' && identifier.name && isLoggerProducer(declaration.init)) {
          knownLoggers.add(identifier.name);
        }
      },

      AssignmentExpression(node: Rule.Node): void {
        const assignment = node as AstNode;
        const assignedName = getQualifiedName(assignment.left);
        if (assignedName && isLoggerProducer(assignment.right)) {
          knownLoggers.add(assignedName);
        }
      },

      ExpressionStatement(node: Rule.Node): void {
        const statement = node as AstNode;
        const methods: string[] = [];
        const root = collectCallChain(statement.expression, methods);
        if (!root || !knownLoggers.has(root)) {
          return;
        }
        const levelIndex = methods.findIndex((method) => LEVEL_METHODS.has(method));
        if (levelIndex < 0 || methods.slice(levelIndex + 1).includes('send')) {
          return;
        }
        context.report({ node, messageId: 'missingSend' });
      },
    };
  },
};

export const rules = {
  'require-send': requireSendRule,
};

export const eslintPlugin: {
  meta: { name: string; version: string };
  rules: typeof rules;
  configs: Record<string, Linter.Config>;
} = {
  meta: {
    name: '@oresoftware/next-loggers',
    version: '0.1.0',
  },
  rules,
  configs: {},
};

eslintPlugin.configs.recommended = {
  name: '@oresoftware/next-loggers/recommended',
  plugins: {
    'next-loggers': eslintPlugin as ESLint.Plugin,
  },
  rules: {
    'next-loggers/require-send': 'warn',
  },
};

export default eslintPlugin;

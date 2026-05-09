// @ts-check
// Custom oxlint rules for the factory codebase. Mirrors the rule set in
// https://github.com/mikearnaldi/accountability/blob/main/eslint.config.mjs,
// minus the browser-specific rules (no-localstorage, no-direct-fetch,
// no-location-href-redirect) which do not apply to this Node-only Effect project.
//
// Loaded via `jsPlugins` in `.oxlintrc.json`. Plugin namespace is `factory/`.

function getSource(context) {
	return context.sourceCode ?? context.getSourceCode();
}

const importExtensionsRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Enforce .ts/.tsx extension for relative imports and no extension for package imports',
		},
		messages: {
			relativeRequiresTs:
				"Relative imports must use .ts or .tsx extension. Change '{{source}}' to '{{source}}.ts'",
			relativeNoJs:
				"Relative imports must use .ts or .tsx extension, not .js/.jsx. Change '{{source}}' to '{{fixed}}'",
			packageNoExtension:
				"Package imports must not have an extension. Change '{{source}}' to '{{fixed}}'",
		},
		schema: [],
	},
	create(context) {
		// Non-script extensions that are legitimate relative imports (Vite/Nuxt assets,
		// Vue/Svelte single-file components, JSON, etc.). Script imports must still
		// use .ts/.tsx — anything else is fine as-is.
		const ALLOWED_NON_SCRIPT =
			/\.(json|vue|svelte|css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|html|md|wasm)$/;

		function checkImportSource(node, source) {
			if (!source || typeof source !== 'string') return;

			const isRelative = source.startsWith('./') || source.startsWith('../');

			if (isRelative) {
				if (source.includes('?')) return;
				if (source.endsWith('.js') || source.endsWith('.jsx')) {
					const fixed = source.replace(/\.jsx?$/, '.ts');
					context.report({ node, messageId: 'relativeNoJs', data: { source, fixed } });
				} else if (
					!source.endsWith('.ts') &&
					!source.endsWith('.tsx') &&
					!ALLOWED_NON_SCRIPT.test(source)
				) {
					context.report({ node, messageId: 'relativeRequiresTs', data: { source } });
				}
			} else if (
				source.endsWith('.ts') ||
				source.endsWith('.tsx') ||
				source.endsWith('.js') ||
				source.endsWith('.jsx')
			) {
				const fixed = source.replace(/\.(tsx?|jsx?)$/, '');
				context.report({ node, messageId: 'packageNoExtension', data: { source, fixed } });
			}
		}

		return {
			ImportDeclaration(node) {
				checkImportSource(node, node.source?.value);
			},
			ImportExpression(node) {
				if (node.source?.type === 'Literal') {
					checkImportSource(node, node.source.value);
				}
			},
			ExportNamedDeclaration(node) {
				if (node.source) checkImportSource(node, node.source.value);
			},
			ExportAllDeclaration(node) {
				checkImportSource(node, node.source?.value);
			},
		};
	},
};

const noDisableValidationRule = {
	meta: {
		type: 'problem',
		docs: { description: 'Disallow disableValidation: true in Schema operations' },
		messages: {
			noDisableValidation:
				"Do not use { disableValidation: true }. Schema validation should always be enabled to catch invalid data. If you're seeing validation errors, fix the data or schema instead of disabling validation.",
		},
		schema: [],
	},
	create(context) {
		return {
			Property(node) {
				if (
					node.key &&
					((node.key.type === 'Identifier' && node.key.name === 'disableValidation') ||
						(node.key.type === 'Literal' && node.key.value === 'disableValidation')) &&
					node.value &&
					node.value.type === 'Literal' &&
					node.value.value === true
				) {
					context.report({ node, messageId: 'noDisableValidation' });
				}
			},
		};
	},
};

const noSqlTypeParameterRule = {
	meta: {
		type: 'problem',
		docs: { description: 'Disallow type parameters on sql template literals' },
		messages: {
			noSqlTypeParam:
				'Do not use sql<Type>`...`. Type parameters provide no runtime validation. Use SqlSchema.findOne/findAll/single/void with a Schema for type-safe queries that validate at runtime.',
		},
		schema: [],
	},
	create(context) {
		return {
			TaggedTemplateExpression(node) {
				if (!node.typeArguments && !node.typeParameters) return;
				const tag = node.tag;
				const isSql =
					(tag.type === 'Identifier' && tag.name === 'sql') ||
					(tag.type === 'MemberExpression' &&
						tag.property.type === 'Identifier' &&
						tag.property.name === 'sql');
				if (isSql) context.report({ node, messageId: 'noSqlTypeParam' });
			},
		};
	},
};

const preferOptionFromNullableRule = {
	meta: {
		type: 'suggestion',
		docs: { description: 'Prefer Option.fromNullable over ternary with Option.some/none' },
		messages: {
			preferFromNullable:
				'Use Option.fromNullable({{name}}) instead of ternary with Option.some/Option.none.',
		},
		schema: [],
	},
	create(context) {
		const sourceCode = getSource(context);
		return {
			ConditionalExpression(node) {
				const { test, consequent, alternate } = node;
				if (test.type !== 'BinaryExpression') return;
				if (test.operator !== '!==' && test.operator !== '!=') return;

				let testedName = null;
				if (
					test.left.type === 'Identifier' &&
					test.right.type === 'Literal' &&
					test.right.value === null
				) {
					testedName = test.left.name;
				} else if (
					test.right.type === 'Identifier' &&
					test.left.type === 'Literal' &&
					test.left.value === null
				) {
					testedName = test.right.name;
				} else if (
					test.left.type === 'MemberExpression' &&
					test.right.type === 'Literal' &&
					test.right.value === null
				) {
					testedName = sourceCode.getText(test.left);
				} else if (
					test.right.type === 'MemberExpression' &&
					test.left.type === 'Literal' &&
					test.left.value === null
				) {
					testedName = sourceCode.getText(test.right);
				}
				if (!testedName) return;

				if (consequent.type !== 'CallExpression') return;
				const conseqCallee = consequent.callee;
				const isOptionSome =
					conseqCallee.type === 'MemberExpression' &&
					conseqCallee.object.type === 'Identifier' &&
					conseqCallee.object.name === 'Option' &&
					conseqCallee.property.type === 'Identifier' &&
					conseqCallee.property.name === 'some';
				if (!isOptionSome) return;

				if (alternate.type !== 'CallExpression') return;
				const altCallee = alternate.callee;
				const isOptionNone =
					(altCallee.type === 'MemberExpression' &&
						altCallee.object.type === 'Identifier' &&
						altCallee.object.name === 'Option' &&
						altCallee.property.type === 'Identifier' &&
						altCallee.property.name === 'none') ||
					(altCallee.type === 'TSInstantiationExpression' &&
						altCallee.expression.type === 'MemberExpression' &&
						altCallee.expression.object.type === 'Identifier' &&
						altCallee.expression.object.name === 'Option' &&
						altCallee.expression.property.type === 'Identifier' &&
						altCallee.expression.property.name === 'none');
				if (!isOptionNone) return;

				context.report({
					node,
					messageId: 'preferFromNullable',
					data: { name: testedName },
				});
			},
		};
	},
};

const pipeMaxArgumentsRule = {
	meta: {
		type: 'problem',
		docs: { description: 'Disallow .pipe() with more than 20 arguments' },
		messages: {
			tooManyArgs:
				'.pipe() has {{count}} arguments. Consider splitting into multiple .pipe() calls for readability (max 20).',
		},
		schema: [],
	},
	create(context) {
		return {
			CallExpression(node) {
				const callee = node.callee;
				if (
					callee.type === 'MemberExpression' &&
					callee.property.type === 'Identifier' &&
					callee.property.name === 'pipe' &&
					node.arguments.length > 20
				) {
					context.report({
						node,
						messageId: 'tooManyArgs',
						data: { count: String(node.arguments.length) },
					});
				}
			},
		};
	},
};

function makeBannedEffectMemberRule({ name, messageId, message }) {
	return {
		meta: {
			type: 'problem',
			docs: { description: message },
			messages: { [messageId]: message },
			schema: [],
		},
		create(context) {
			return {
				MemberExpression(node) {
					if (
						node.object.type === 'Identifier' &&
						node.object.name === 'Effect' &&
						node.property.type === 'Identifier' &&
						node.property.name === name
					) {
						context.report({ node, messageId });
					}
				},
			};
		},
	};
}

const noEffectAsVoidRule = makeBannedEffectMemberRule({
	name: 'asVoid',
	messageId: 'noEffectAsVoid',
	message:
		'Effect.asVoid is usually unnecessary. The `void` return type already allows any value to be returned from an effect. Remove it.',
});

const noEffectIgnoreRule = makeBannedEffectMemberRule({
	name: 'ignore',
	messageId: 'noEffectIgnore',
	message:
		'Do not use Effect.ignore. It silently discards errors which hides bugs. Handle errors explicitly with Effect.catchTag, Effect.catchAll, or propagate them.',
});

const noEffectCatchAllCauseRule = makeBannedEffectMemberRule({
	name: 'catchAllCause',
	messageId: 'noEffectCatchAllCause',
	message:
		'Do not use Effect.catchAllCause. It catches defects (bugs) which should crash the program. Use Effect.catchAll or Effect.catchTag to handle expected errors only.',
});

const noServiceOptionRule = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow Effect.serviceOption - services should always be present in context',
		},
		messages: {
			noServiceOption:
				'Do not use Effect.serviceOption. Services should always be present in context, even during testing. Yield the service directly (yield* MyService) and ensure it is provided in your layer composition.',
		},
		schema: [],
	},
	create(context) {
		return {
			CallExpression(node) {
				const callee = node.callee;
				if (
					callee.type === 'MemberExpression' &&
					callee.object.type === 'Identifier' &&
					callee.object.name === 'Effect' &&
					callee.property.type === 'Identifier' &&
					callee.property.name === 'serviceOption'
				) {
					context.report({ node, messageId: 'noServiceOption' });
				}
			},
		};
	},
};

const noSilentErrorSwallowRule = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow catch handlers that silently swallow errors by returning Effect.void',
		},
		messages: {
			noSilentSwallow:
				"Do not silently swallow errors with '() => Effect.void'. Errors should be represented in the type system, not ignored. Either: (1) let the error propagate to the caller, (2) transform it with mapError to a different error type, or (3) handle it with meaningful recovery logic. Silent error swallowing hides bugs and breaks type safety.",
		},
		schema: [],
	},
	create(context) {
		function isEffectVoidOrUnit(node) {
			if (!node || node.type !== 'MemberExpression') return false;
			return (
				node.object.type === 'Identifier' &&
				node.object.name === 'Effect' &&
				node.property.type === 'Identifier' &&
				(node.property.name === 'void' || node.property.name === 'unit')
			);
		}

		function isVoidReturningHandler(node) {
			if (!node) return false;
			if (node.type === 'ArrowFunctionExpression') {
				if (isEffectVoidOrUnit(node.body)) return true;
				if (node.body.type === 'BlockStatement') {
					const body = node.body.body;
					if (body.length === 1 && body[0].type === 'ReturnStatement') {
						return isEffectVoidOrUnit(body[0].argument);
					}
				}
			}
			if (node.type === 'FunctionExpression') {
				const body = node.body.body;
				if (body.length === 1 && body[0].type === 'ReturnStatement') {
					return isEffectVoidOrUnit(body[0].argument);
				}
			}
			return false;
		}

		function catchKind(node) {
			if (node.type !== 'CallExpression') return null;
			const callee = node.callee;
			if (callee.type !== 'MemberExpression') return null;
			const propName = callee.property.type === 'Identifier' ? callee.property.name : null;
			if (propName !== 'catchTag' && propName !== 'catchAll' && propName !== 'catchTags')
				return null;
			if (callee.object.type === 'Identifier' && callee.object.name === 'Effect') {
				return propName;
			}
			return null;
		}

		return {
			CallExpression(node) {
				const kind = catchKind(node);
				if (!kind) return;

				if (kind === 'catchTag' && node.arguments.length >= 2) {
					const handler = node.arguments[1];
					if (isVoidReturningHandler(handler)) {
						context.report({ node: handler, messageId: 'noSilentSwallow' });
					}
				} else if (kind === 'catchAll' && node.arguments.length >= 1) {
					const handler = node.arguments[0];
					if (isVoidReturningHandler(handler)) {
						context.report({ node: handler, messageId: 'noSilentSwallow' });
					}
				} else if (kind === 'catchTags' && node.arguments.length >= 1) {
					const obj = node.arguments[0];
					if (obj.type === 'ObjectExpression') {
						for (const prop of obj.properties) {
							if (prop.type === 'Property' && isVoidReturningHandler(prop.value)) {
								context.report({ node: prop.value, messageId: 'noSilentSwallow' });
							}
						}
					}
				}
			},
		};
	},
};

const noVoidExpressionRule = {
	meta: {
		type: 'problem',
		docs: { description: 'Disallow void expressions - they are no-ops' },
		messages: {
			noVoidExpression:
				"'void {{expression}}' is a no-op. It evaluates the expression and discards the result. Remove it or use the value.",
		},
		schema: [],
	},
	create(context) {
		const sourceCode = getSource(context);
		return {
			UnaryExpression(node) {
				if (node.operator === 'void') {
					const expression = sourceCode.getText(node.argument);
					context.report({ node, messageId: 'noVoidExpression', data: { expression } });
				}
			},
		};
	},
};

const noNestedLayerProvideRule = {
	meta: {
		type: 'problem',
		docs: { description: 'Disallow nested Layer.provide calls' },
		messages: {
			nestedProvide:
				'Nested Layer.provide detected. Extract the inner Layer.provide to a separate variable or use Layer.provideMerge.',
		},
		schema: [],
	},
	create(context) {
		function isLayerProvide(node) {
			if (!node || node.type !== 'CallExpression') return false;
			const callee = node.callee;
			return (
				callee.type === 'MemberExpression' &&
				callee.object.type === 'Identifier' &&
				callee.object.name === 'Layer' &&
				callee.property.type === 'Identifier' &&
				callee.property.name === 'provide'
			);
		}

		return {
			CallExpression(node) {
				if (!isLayerProvide(node)) return;
				for (const arg of node.arguments) {
					if (isLayerProvide(arg)) {
						context.report({ node: arg, messageId: 'nestedProvide' });
					}
				}
			},
		};
	},
};

const plugin = {
	meta: { name: 'factory' },
	rules: {
		'import-extensions': importExtensionsRule,
		'no-disable-validation': noDisableValidationRule,
		'no-sql-type-parameter': noSqlTypeParameterRule,
		'prefer-option-from-nullable': preferOptionFromNullableRule,
		'pipe-max-arguments': pipeMaxArgumentsRule,
		'no-effect-asvoid': noEffectAsVoidRule,
		'no-effect-ignore': noEffectIgnoreRule,
		'no-effect-catchallcause': noEffectCatchAllCauseRule,
		'no-service-option': noServiceOptionRule,
		'no-silent-error-swallow': noSilentErrorSwallowRule,
		'no-void-expression': noVoidExpressionRule,
		'no-nested-layer-provide': noNestedLayerProvideRule,
	},
};

export default plugin;

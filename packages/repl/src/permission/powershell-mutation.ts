import path from 'node:path';

export type PowerShellMutationOperation =
  | {
    readonly kind: 'write' | 'create' | 'delete';
    readonly target: string;
    readonly options: Readonly<Record<string, boolean | string>>;
  }
  | {
    readonly kind: 'copy' | 'move' | 'rename';
    readonly source: string;
    readonly destination: string;
    readonly options: Readonly<Record<string, boolean | string>>;
  };

export interface PowerShellMutationAnalysis {
  readonly status: 'complete' | 'incomplete';
  readonly operations: readonly PowerShellMutationOperation[];
  readonly reason?: string;
}

type ParameterKind = 'switch' | 'value';

interface CommandSpec {
  readonly positionals: readonly string[];
  readonly parameters: Readonly<Record<string, ParameterKind>>;
}

interface BoundArguments {
  readonly complete: boolean;
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly reason?: string;
}

const COMMON_PARAMETERS: Readonly<Record<string, ParameterKind>> = {
  verbose: 'switch', debug: 'switch', erroraction: 'value', warningaction: 'value',
  informationaction: 'value', progressaction: 'value', errorvariable: 'value',
  warningvariable: 'value', informationvariable: 'value', outvariable: 'value',
  outbuffer: 'value', pipelinevariable: 'value', whatif: 'switch', confirm: 'switch',
  usetransaction: 'switch',
};

const PATH_FILTER_PARAMETERS: Readonly<Record<string, ParameterKind>> = {
  path: 'value', literalpath: 'value', filter: 'value', include: 'value', exclude: 'value',
};

const COMMAND_SPECS: Readonly<Record<string, CommandSpec>> = {
  'copy-item': spec(['path', 'destination'], {
    ...PATH_FILTER_PARAMETERS, destination: 'value', container: 'switch', recurse: 'switch',
    force: 'switch', passthru: 'switch', credential: 'value', fromsession: 'value',
    tosession: 'value',
  }),
  'move-item': spec(['path', 'destination'], {
    ...PATH_FILTER_PARAMETERS, destination: 'value', force: 'switch', passthru: 'switch',
    credential: 'value',
  }),
  'set-content': spec(['path', 'value'], {
    ...PATH_FILTER_PARAMETERS, value: 'value', passthru: 'switch', force: 'switch',
    credential: 'value', nonewline: 'switch', encoding: 'value', asbytestream: 'switch',
    stream: 'value',
  }),
  'add-content': spec(['path', 'value'], {
    ...PATH_FILTER_PARAMETERS, value: 'value', passthru: 'switch', force: 'switch',
    credential: 'value', nonewline: 'switch', encoding: 'value', asbytestream: 'switch',
    stream: 'value',
  }),
  'out-file': spec(['filepath', 'encoding'], {
    filepath: 'value', literalpath: 'value', inputobject: 'value', encoding: 'value', append: 'switch',
    force: 'switch', noclobber: 'switch', width: 'value', nonewline: 'switch',
  }),
  'new-item': spec(['path'], {
    path: 'value', name: 'value', itemtype: 'value', value: 'value', force: 'switch',
    credential: 'value',
  }),
  ni: spec(['path'], {
    path: 'value', name: 'value', itemtype: 'value', value: 'value', force: 'switch',
    credential: 'value',
  }),
  'remove-item': spec(['path'], {
    ...PATH_FILTER_PARAMETERS, recurse: 'switch', force: 'switch', credential: 'value',
    stream: 'value',
  }),
  'rename-item': spec(['path', 'newname'], {
    path: 'value', literalpath: 'value', newname: 'value', force: 'switch',
    passthru: 'switch', credential: 'value',
  }),
};

const PARAMETER_ALIASES: Readonly<Record<string, string>> = {
  ea: 'erroraction', ev: 'errorvariable', wa: 'warningaction', wv: 'warningvariable',
  ia: 'informationaction', infa: 'informationaction', iv: 'informationvariable',
  ov: 'outvariable', ob: 'outbuffer', pv: 'pipelinevariable', vb: 'verbose', db: 'debug',
  wi: 'whatif', cf: 'confirm', usetx: 'usetransaction', pspath: 'literalpath',
  nooverwrite: 'noclobber', type: 'itemtype', target: 'value',
};

function spec(
  positionals: readonly string[],
  parameters: Readonly<Record<string, ParameterKind>>,
): CommandSpec {
  return { positionals, parameters: { ...COMMON_PARAMETERS, ...parameters } };
}

export function isPowerShellMutationCommand(command: string): boolean {
  return COMMAND_SPECS[command.toLowerCase()] !== undefined;
}

export function analyzePowerShellMutation(
  argv: readonly string[],
): PowerShellMutationAnalysis {
  const command = commandName(argv[0] ?? '');
  const commandSpec = COMMAND_SPECS[command];
  if (!commandSpec) return incomplete(`unsupported PowerShell command: ${command || '<empty>'}`);

  const bound = bindArguments(argv.slice(1), commandSpec);
  if (!bound.complete) return incomplete(bound.reason ?? 'PowerShell parameter binding is incomplete');
  if (bound.values.has('fromsession') || bound.values.has('tosession')) {
    return incomplete('PowerShell remoting changes the filesystem host');
  }
  if ((command === 'new-item' || command === 'ni')
    && /^(?:symboliclink|junction|hardlink)$/i.test(bound.values.get('itemtype') ?? '')) {
    return incomplete('PowerShell link creation has an unmodelled target relationship');
  }
  if (hasUnmodelledBracketWildcard(bound)) {
    return incomplete('PowerShell path contains bracket wildcard syntax');
  }

  const operation = buildOperation(command, bound);
  if (!operation) return incomplete('PowerShell mutation target is missing or ambiguous');
  if (operationPaths(operation).some(isAmbiguousPathExpression)) {
    return {
      status: 'incomplete', operations: [operation],
      reason: 'PowerShell path contains dynamic, wildcard, or array syntax',
    };
  }
  return { status: 'complete', operations: [operation] };
}

function bindArguments(args: readonly string[], commandSpec: CommandSpec): BoundArguments {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  let positionalIndex = 0;
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('-')) {
      const parsed = parseParameter(token, commandSpec);
      if (!parsed) return failed(values, switches, `unknown or ambiguous parameter ${token}`);
      if (parsed.kind === 'switch') {
        const enabled = parseSwitchValue(parsed.inlineValue);
        if (enabled === undefined) {
          return failed(values, switches, `switch ${token} has an unsupported value`);
        }
        if (enabled) switches.add(parsed.name);
        continue;
      }
      const value = parsed.inlineValue ?? args[index + 1];
      if (value === undefined || (parsed.inlineValue === undefined && value.startsWith('-'))) {
        return failed(values, switches, `parameter ${token} has no bound value`);
      }
      if (values.has(parsed.name)) {
        return failed(values, switches, `parameter ${token} is repeated`);
      }
      values.set(parsed.name, value);
      if (parsed.inlineValue === undefined) index += 1;
      continue;
    }

    while (commandSpec.positionals[positionalIndex]
      && values.has(commandSpec.positionals[positionalIndex]!)) positionalIndex += 1;
    const name = commandSpec.positionals[positionalIndex];
    if (!name || values.has(name)) {
      return failed(values, switches, `unexpected positional argument ${token}`);
    }
    values.set(name, token);
    positionalIndex += 1;
  }
  return { complete: true, values, switches };
}

function parseParameter(
  token: string,
  commandSpec: CommandSpec,
): { readonly name: string; readonly kind: ParameterKind; readonly inlineValue?: string } | undefined {
  const match = /^--?([^:]+)(?::(.*))?$/.exec(token);
  if (!match) return undefined;
  const rawName = match[1]!.toLowerCase();
  const alias = PARAMETER_ALIASES[rawName];
  const names = Object.keys(commandSpec.parameters);
  const matches = alias && commandSpec.parameters[alias] !== undefined
    ? [alias]
    : names.filter((name) => name.startsWith(rawName));
  if (matches.length !== 1) return undefined;
  const name = matches[0]!;
  const kind = commandSpec.parameters[name]!;
  return match[2] === undefined ? { name, kind } : { name, kind, inlineValue: match[2] };
}

function buildOperation(
  command: string,
  bound: BoundArguments,
): PowerShellMutationOperation | undefined {
  const source = pathValue(bound, 'path', 'literalpath');
  const force = bound.switches.has('force');
  const whatIfOptions: Readonly<Record<string, boolean>> = bound.switches.has('whatif')
    ? { whatIf: true }
    : {};
  if (command === 'copy-item' || command === 'move-item') {
    if (!source) return undefined;
    const destination = bound.values.get('destination') ?? defaultDestination(source);
    return {
      kind: command === 'copy-item' ? 'copy' : 'move',
      source,
      destination,
      options: {
        force,
        ...whatIfOptions,
        recursive: command === 'copy-item' && bound.switches.has('recurse'),
        overwritePossible: true,
      },
    };
  }
  if (command === 'rename-item') {
    const newName = bound.values.get('newname');
    if (!source || !newName || /[\\/]/.test(newName)) return undefined;
    return {
      kind: 'rename', source, destination: joinSourceParent(source, newName),
      options: { force, ...whatIfOptions },
    };
  }
  if (command === 'new-item' || command === 'ni') {
    const name = bound.values.get('name');
    const target = name ? joinPath(bound.values.get('path') ?? '.', name) : bound.values.get('path');
    const itemType = bound.values.get('itemtype');
    const options = itemType
      ? { force, ...whatIfOptions, itemType }
      : { force, ...whatIfOptions };
    return target ? { kind: 'create', target, options } : undefined;
  }
  const target = command === 'out-file'
    ? pathValue(bound, 'filepath', 'literalpath')
    : source;
  if (!target) return undefined;
  if (command === 'remove-item') {
    return {
      kind: 'delete', target,
      options: { force, ...whatIfOptions, recursive: bound.switches.has('recurse') },
    };
  }
  return {
    kind: 'write', target,
    options: {
      force,
      ...whatIfOptions,
      append: command === 'add-content' || bound.switches.has('append'),
    },
  };
}

function pathValue(bound: BoundArguments, ...names: readonly string[]): string | undefined {
  const present = names.map((name) => bound.values.get(name)).filter((value): value is string => Boolean(value));
  return present.length === 1 ? present[0] : undefined;
}

function operationPaths(operation: PowerShellMutationOperation): readonly string[] {
  return 'target' in operation
    ? [operation.target]
    : [operation.source, operation.destination];
}

function isAmbiguousPathExpression(value: string): boolean {
  return /[,*?`$]|@\(|[{}]/.test(value) || isPowerShellProviderPath(value);
}

function hasUnmodelledBracketWildcard(bound: BoundArguments): boolean {
  return ['path', 'filepath', 'destination', 'newname', 'name'].some((name) =>
    /[\[\]]/.test(bound.values.get(name) ?? ''),
  );
}

function isPowerShellProviderPath(value: string): boolean {
  if (/^[a-z]:[\\/]/i.test(value)) return false;
  return /^[a-z][a-z0-9_.-]*:/i.test(value);
}

function parseSwitchValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return true;
  if (/^\$?true$|^1$/i.test(value)) return true;
  if (/^\$?false$|^0$/i.test(value)) return false;
  return undefined;
}

function defaultDestination(source: string): string {
  const flavor = /^[a-z]:|\\/i.test(source) ? path.win32 : path.posix;
  return flavor.join('.', flavor.basename(source));
}

function joinSourceParent(source: string, name: string): string {
  const flavor = /^[a-z]:|\\/i.test(source) ? path.win32 : path.posix;
  return flavor.join(flavor.dirname(source), name);
}

function joinPath(parent: string, child: string): string {
  const flavor = /^[a-z]:|\\/i.test(parent) ? path.win32 : path.posix;
  return flavor.join(parent, child);
}

function commandName(value: string): string {
  return value.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
}

function failed(
  values: ReadonlyMap<string, string>,
  switches: ReadonlySet<string>,
  reason: string,
): BoundArguments {
  return { complete: false, values, switches, reason };
}

function incomplete(reason: string): PowerShellMutationAnalysis {
  return { status: 'incomplete', operations: [], reason };
}

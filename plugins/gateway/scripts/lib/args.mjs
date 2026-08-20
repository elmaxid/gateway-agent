export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        if (inlineValue === undefined && nextValue.startsWith("-") && nextValue !== "-") {
          throw new Error(
            `Missing value for --${rawKey}: next token "${nextValue}" is another option. ` +
            `Use --${rawKey}=<value> when the value itself starts with "-".`
          );
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      // No inline `-k=value` form exists on the short branch, so this message must not
      // advertise one — that syntax falls through to positionals here.
      if (nextValue.startsWith("-") && nextValue !== "-") {
        throw new Error(`Missing value for -${shortKey}: next token "${nextValue}" is another option.`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

const MAX_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1, Node's setTimeout limit — larger values overflow and fire almost immediately

export function validateTimeoutOption(rawValue, flagName = "timeout") {
  if (rawValue === undefined) {
    return undefined;
  }

  const num = Number(rawValue);
  if (!Number.isFinite(num) || num <= 0 || num > MAX_TIMEOUT_MS) {
    throw new Error(
      `Invalid --${flagName} "${rawValue}". Expected a positive number of milliseconds (max ${MAX_TIMEOUT_MS}).`
    );
  }

  return num;
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

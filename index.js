import * as epilog from '@epilog/epilog';
import { v4 as getUuid } from 'uuid';

/**
 * @param program Structured IPDL program.
 * @returns {string} Epilog code corresponding to `program`.
 */
export function programToEpilog(program, context = []) {
  let code = '% Declarations\n\n';

  code += Object.entries(program.declarations).map(([name, decl]) => {
    return declarationToEpilog(name, decl);
  }).join('\n\n');

  code += '\n\n% Chains\n\n';

  code += Object.entries(program.chains).map(([name, chain]) => {
    return chainToEpilog(name, chain);
  }).join('\n\n');

  return code;
}

function declarationToEpilog(name, declaration) {
  if (declaration.class === 'Dictionary') {
    return Object.entries(declaration.properties).map(([innerName, innerDecl]) => {
      return declarationToEpilog(declaration.name + '.' + innerName, innerDecl);
    }).join('\n\n');
  } else if (declaration.type === 'object') {
    let code = epilog.grind(['object', `"${name}"`]);
    code += Object.entries(declaration.properties).map(([propName, propVal]) => {
      return '\n' + epilog.grind(['prop', `"${name}"`, `"${propName}"`, ipdlToEpilog(propVal)]);
    });
    return code;
  }

  throw new Error(`Unrecognized declaration "${name}": ${JSON.stringify(declaration)}`);
}

function chainToEpilog(name, chain) {
  const chainSymbol = `chain_${name}`;
  let code = `chain(${chainSymbol})\n`;

  const chainMatch = ['rule',
                      ['matches_chain', chainSymbol, 'Situation']];

  chain.children.forEach(situation => {
    const [sitCode, sitSymbol] = situationToEpilog(situation);
    code += sitCode + '\n';
    chainMatch.push(['situation', 'Situation']);
    chainMatch.push(['matches_situation', sitSymbol, 'Situation']);
  });

  code += epilog.grind(chainMatch);

  const annotationsCode = (chain.annotations || []).map(annotation => {
    return annotationToEpilog(annotation, chainSymbol);
  }).join('\n');

  if (annotationsCode) {
    code += '\n' + annotationsCode;
  }

  return code;
}

function situationToEpilog(situation, chain) {
  if (situation.type === 'any') {
    const situationSymbol = `situation_${getUuid()}`;
    let code = '';
    const rule = ['rule',
                  ['matches_situation', situationSymbol, 'Situation'],
                  ['situation', 'Situation']];

    return [epilog.grind(rule), situationSymbol];
  } else if (situation.type === 'block') {
    const situationSymbol = `situation_${getUuid()}`;
    let code = '';
    const situationVar = 'Situation';
    const rule = ['rule',
                  ['matches_situation', situationSymbol, situationVar],
                  ['situation', situationVar]];

    Object.entries(situation.properties).forEach(([key, val]) => {
      if (key === 'event' && val.type === 'expression') {
        const [exprCode, exprSymbol] = expressionToEpilog(val);
        code += exprCode;
        rule.push(['prop', situationVar, '"event"', `${situationVar}.event`]);
        rule.push(['matches_situation', exprSymbol, `${situationVar}.event`]);
      } else if (key === 'event') {
        rule.push(['prop', situationVar, '"event"', `"${val.value}"`]);
      }
    });

    code += epilog.grind(rule);

    return [code, situationSymbol];
  } else if (situation.type === 'logic_block') {
    return ['', `situation_${getUuid()}`];
  } else if (situation.type === 'operation' && situation.operator === 'causal') {
    return causalToEpilog(situation);
  } else if (situation.type === 'operation' && situation.operator === 'or') {
    return orToEpilog(situation);
  } else if (situation.type ===  'rule_call') {
    return ruleCallToEpilog(situation);
  } else if (situation.type === 'variable') {
    const sitSymbol = `situation_${getUuid()}`;
    let code = '';

    code += epilog.grind(['rule',
                          ['matches_situation', sitSymbol, 'Situation'],
                          ['matches_situation', `matches_situation_${situation.value}`, 'Situation']]);

    return [code, sitSymbol];
  }

  throw new Error(`Unparsable situation: ${JSON.stringify(situation)}`);
}

function expressionToEpilog(expression) {
  // assuming `or` expression
  const sitSymbol = `situation_${getUuid()}`;
  let code = '';

  expression.children.forEach(operand => {
    const [opCode, opSymbol] = situationToEpilog(operand);
    code += opCode + '\n';
    code += epilog.grind(['rule',
                          ['matches_situation', sitSymbol, 'Situation'],
                          ['matches_situation', opSymbol, 'Situation']]);
    code += '\n';
  });

  return [code, sitSymbol];
}

function causalToEpilog(causal) {
  const situationSymbol = `situation_${getUuid()}`;
  let code = '';
  const operandSymbols = [];

  // Stringify situations
  causal.children.forEach((situation, i) => {
    const [sitCode, sitSymbol] = situationToEpilog(situation);
    code += sitCode + '\n';
    operandSymbols.push(sitSymbol);
  });

  const matchRule = ['rule',
                     ['matches_situation', situationSymbol, 'Situation'],
                     ['matches_situation', operandSymbols[operandSymbols.length - 1], 'Situation']];

  let currentVar = `Situation`;

  // Stringify causal relationships
  // i > 0 skips the last operand on purpose; we aren't interested in first causes
  for (let i = causal.children.length - 1; i > 0; i--) {
    const situation = causal.children[i];

    // skip wildcards, they're only relevant in terms of their neighbours
    if (situation.type === 'any') continue;

    const direct = causal.children[i - 1]?.type !== 'any';
    const previousVar = currentVar;
    currentVar = `Situation_${getUuid()}`;

    if (direct) {
      matchRule.push(['matches_situation', operandSymbols[i - 1], currentVar]);
      matchRule.push(['direct_cause', currentVar, previousVar]);
    } else {
      matchRule.push(['matches_situation', operandSymbols[i - 2], currentVar]);
      matchRule.push(['indirect_cause', currentVar, previousVar]);
    }
  }

  code += epilog.grind(matchRule);

  return [code, situationSymbol];
}

function orToEpilog(orOp) {
  const situationSymbol = `situation_${getUuid()}`;
  let code = '';
  const operandSymbols = [];

  // Stringify situations
  orOp.children.forEach((situation, i) => {
    const [sitCode, sitSymbol] = situationToEpilog(situation);
    code += sitCode + '\n';
    if (sitSymbol) operandSymbols.push(sitSymbol);
  });

  // Stringify disjunctions
  code += operandSymbols.map(operand => {
    return epilog.grind(['rule',
                         ['matches_situation', situationSymbol, 'Situation'],
                         ['situation', 'Situation'],
                         ['matches_situation', operand, 'Situation']]);
  }).join('\n');

  return [code, situationSymbol];
}

function ruleCallToEpilog(ruleCall) {
  const situationSymbol = `situation_${getUuid()}`;
  let code = '';

  code += epilog.grind(['rule',
                        ['matches_situation', situationSymbol, 'Situation'],
                        ['situation', 'Situation'],
                        // XXX fix name handling
                        ['matches_chain', `chain_${ruleCall.name}`, 'Situation']]);

  return [code, situationSymbol];
}

function ipdlToEpilog(ipdl) {
  if (ipdl.type === 'object') {
    return objectToEpilog(ipdl);
  } else if (ipdl.type === 'string') {
    return `"${ipdl.value}"`;
  }

  throw new Error(`Unknown IPDL item type: ${JSON.stringify(ipdl)}`);
}

function objectToEpilog(name, obj, kind) {
  const symbol = `object_${name}`;
  let code = epilog.grind([kind || 'object', symbol]) + '\n';
  code += Object.entries(obj.properties).map(([key, val]) => {
    const [code, symbol] = ipdlToEpilog(val);
    if (val.type === 'object') throw new Error(`Nested object: ${JSON.stringify(obj)}`);
    return epilog.grind(['prop', symbol, `${key}`, ipdlToEpilog(val)]);
  }).join('\n');

  return [code, symbol];
}

function annotationToEpilog(annotation, target) {
  if (!target) throw new Error(`Orphan annotation "${annotation.name}" on ${target}`);

  const annotationSymbol = `${target}_annotation_${annotation.name}`;

  let code = epilog.grind(['annotation', target, `"${annotation.name}"`, annotationSymbol]) + '\n';

  code += Object.entries(annotation.properties).map(([key, rawVal]) => {
    let val = rawVal.value;
    // TODO variables
    if (rawVal.type === 'string') {
      val = JSON.stringify(rawVal.value);
    }

    return epilog.grind(['prop', annotationSymbol, `"${key}"`, val]);
  }).join('\n');

  return code;
}

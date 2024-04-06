import type { PostfixExpression } from 'boon-js';
import { parse as boonParse } from 'boon-js';
import type { Token } from 'boon-js/lib/types';

import { parseFilter } from '../FilterParser';
import type { Task } from '../../Task/Task';
import { Explanation } from '../Explain/Explanation';
import type { SearchInfo } from '../SearchInfo';
import { Field } from './Field';
import { FilterOrErrorMessage } from './FilterOrErrorMessage';
import { Filter } from './Filter';
import { BooleanDelimiters, anyOfTheseChars } from './BooleanDelimiters';

export type ParseResult = {
    simplifiedLine: string;
    filters: { [key: string]: string };
};

/**
 * BooleanField is a 'container' field type that parses a high-level filtering query of
 * the format --
 *    (filter1) AND ((filter2) OR (filter3))
 * The filters can be mixed and matched with any boolean operators as long as the individual filters are
 * wrapped in either parenthesis or quotes -- (filter1) or "filter1".
 * What happens internally is that when the boolean field is asked to create a filter, it parses the boolean
 * query into a logical postfix expression (https://en.wikipedia.org/wiki/Reverse_Polish_notation),
 * with the individual filter components as "identifier" tokens.
 * These identifiers have an associated actual Filter (which is cached during the query parsing).
 * The returned Filter of the whole boolean query is eventually a function that for each Task object,
 * evaluates the complete postfix expression by going through the individual filters and then resolving
 * the expression into a single boolean entity.
 */
export class BooleanField extends Field {
    private readonly basicBooleanRegexp: RegExp;
    private readonly supportedOperators = ['AND', 'OR', 'XOR', 'NOT'];
    private subFields: Record<string, Filter> = {};

    constructor() {
        super();

        const delimiters = new BooleanDelimiters();
        // First pattern in this matches conventional (filter1) OR (filter2) and similar
        // Second pattern matches (filter1) - that is, ensures that a single filter is treated as valid
        this.basicBooleanRegexp = new RegExp(
            '(.*(AND|OR|XOR|NOT)\\s*' +
                delimiters.openFilter +
                '.*|' +
                delimiters.openFilter +
                '.+' +
                delimiters.closeFilter +
                ')',
            'g',
        );
    }

    protected filterRegExp(): RegExp {
        return this.basicBooleanRegexp;
    }

    public createFilterOrErrorMessage(line: string): FilterOrErrorMessage {
        return this.parseLine(line);
    }

    public fieldName(): string {
        return 'boolean query';
    }

    /**
     * This builds a Filter for a complete boolean query by:
     * 1. Preprocessing the expression into something our helper package, boon-js, knows how to build an expression for.
     * 2. Creating a postfix logical expression using boon-js, which has -
     *    a. Identifiers (leaves), which are regular Field filters represented as their string.
     *    b. Operators, which are logical operators between identifiers or between parenthesis.
     * 3. Creating the filter functions for all the Identifiers in the expression and caching them in this.subFields.
     * 4. Returning a final function filter, which for each Task can run the complete query.
     */
    private parseLine(line: string): FilterOrErrorMessage {
        if (line.length === 0) {
            return FilterOrErrorMessage.fromError(line, 'empty line');
        }
        return this.parseLineV2(line);
    }

    /**
     * New Boolean filter parser
     * @param line
     * @private
     */
    private parseLineV2(line: string) {
        const delimiters = new BooleanDelimiters();
        const parseResult = BooleanField.preprocessExpressionV2(line, delimiters);
        const simplifiedLine = parseResult.simplifiedLine;
        const filters = parseResult.filters;
        try {
            // Convert the (preprocessed) line into a postfix logical expression
            const postfixExpression: Token[] = boonParse(simplifiedLine);
            // Construct sub-field map, i.e. have subFields include a filter function for every
            // final token in the expression
            for (const token of postfixExpression) {
                if (token.name === 'IDENTIFIER' && token.value) {
                    const placeholder = token.value.trim();
                    const filter = filters[placeholder];
                    token.value = filter;
                    if (!(filter in this.subFields)) {
                        const parsedField = parseFilter(filter);
                        if (parsedField === null) {
                            return this.helpMessage(line, `couldn't parse sub-expression '${filter}'`, parseResult);
                        }
                        if (parsedField.error) {
                            return this.helpMessage(
                                line,
                                `couldn't parse sub-expression '${filter}': ${parsedField.error}`,
                                parseResult,
                            );
                        } else if (parsedField.filter) {
                            this.subFields[filter] = parsedField.filter;
                        }
                    }
                } else if (token.name === 'OPERATOR') {
                    // While we're already iterating over the expression, although we don't need the operators at
                    // this stage but only in filterTaskWithParsedQuery below, we're using the opportunity to verify
                    // they are valid. If we won't, then an invalid operator will only be detected when the query is
                    // run on a task
                    if (token.value == undefined) {
                        return this.helpMessage(line, 'empty operator in boolean query', parseResult);
                    }
                    if (!this.supportedOperators.includes(token.value)) {
                        return this.helpMessage(line, `unknown boolean operator '${token.value}'`, parseResult);
                    }
                }
            }
            // Return the filter with filter function that can run the complete query
            const filterFunction = (task: Task, searchInfo: SearchInfo) => {
                return this.filterTaskWithParsedQuery(task, postfixExpression, searchInfo);
            };
            const explanation = this.constructExplanation(postfixExpression);
            return FilterOrErrorMessage.fromFilter(new Filter(line, filterFunction, explanation));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown error type';
            return this.helpMessage(
                line,
                `malformed boolean query -- ${message} (check the documentation for guidelines)`,
                parseResult,
            );
        }
    }

    /**
     * Helper to provide useful information to users, when we fail to interpret a Boolean filter.
     */
    private helpMessage(line: string, errorMessage: string, parseResult: ParseResult) {
        const filters: { [key: string]: string } = parseResult.filters;
        const expressions = Object.entries(filters)
            .map(([key, value]) => {
                return `    "${key}": "${value}"`;
            })
            .join('\n');

        const fullMessage = `Could not interpret the following instruction as a Boolean combination:
    ${line}
The error message is:
    ${errorMessage}
The instruction was converted to the following simplified line:
    ${parseResult.simplifiedLine}
Where the sub-expressions in the simplified line are:
${expressions}
`;
        return FilterOrErrorMessage.fromError(line, fullMessage);
    }

    public static preprocessExpressionV2(line: string, delimiters: BooleanDelimiters): ParseResult {
        const parts = BooleanField.splitLine(line, delimiters);
        return BooleanField.getFiltersAndSimplifiedLine(parts, delimiters);
    }

    public static splitLine(line: string, delimiters: BooleanDelimiters) {
        // TODO Clarify that " can be a delimiter, as well as ()

        // Here, we split the input line in to separate operators-plus-adjacent-parentheses
        // and the remaining filter text.

        // This will now correctly split up almost all valid Boolean instructions - many more cases than the
        // original preprocessExpression() method.
        // The one current exception is that any Spaces and ) at the end of sub-expressions/filters are interpreted
        // as part of the Boolean condition, not the filter.

        // Escape special regex characters for Binary boolean operators and create a regex pattern to match
        // operators and capture surrounding parentheses.
        // To retain backwards compatibility, we match expressions that have missing spaces around AND, OR etc.
        // This matches text such as:
        //   ')AND('
        //   ') AND ('
        //   ')AND  NOT('
        //   ')  AND  NOT  ('
        // TODO Review all uses of space character in these regular expressions, and use \s instead:
        const binaryOperatorsRegex = new RegExp(
            '(' + delimiters.closeFilter + '\\s*(?:AND|OR|AND +NOT|OR +NOT|XOR)\\s*' + delimiters.openFilter + ')',
            'g',
        );

        // Divide up line, split at binary operator boundaries
        const substrings = line.split(binaryOperatorsRegex);

        // Escape special regex characters for Unary boolean operators and create a regex pattern to match
        // operators and capture surrounding parentheses.
        // This matches text such as:
        //   'NOT('
        //   'NOT ('
        //   'NOT  ('
        // TODO Ensure that NOT is at the start of a word - and perhaps is preceded by spaces.
        const unaryOperatorsRegex = new RegExp('(NOT\\s*' + delimiters.openFilter + ')', 'g');

        // Divide up the divided components, this time splitting at unary operator boundaries.
        // flatMap() divides and then flattens the result.
        // Then we filter out empty values.
        const substringsSplitAtOperatorBoundaries = substrings
            .flatMap((substring) => substring.split(unaryOperatorsRegex))
            .filter((substring) => substring !== '');

        // All that remains now is to separate:
        // - any spaces and opening parentheses at the start of filters
        // - any spaces and close   parentheses at the end of filters
        const openingParensAndSpacesAtStartRegex = new RegExp(
            '(^' + anyOfTheseChars(delimiters.openFilterChars + ' ') + '*)',
        );

        const closingParensAndSpacesAtEndRegex = new RegExp(
            '(' + anyOfTheseChars(delimiters.closeFilterChars + ' ') + '*$)',
        );

        return substringsSplitAtOperatorBoundaries
            .flatMap((substring) => substring.split(openingParensAndSpacesAtStartRegex))
            .flatMap((substring) => substring.split(closingParensAndSpacesAtEndRegex))
            .filter((substring) => substring !== '');
    }

    private static getFiltersAndSimplifiedLine(parts: string[], delimiters: BooleanDelimiters) {
        // Holds the reconstructed expression with placeholders
        let simplifiedLine = '';
        let currentIndex = 1; // Placeholder index starts at 1
        const filters: { [key: string]: string } = {}; // To store filter placeholders and their corresponding text

        // Loop to add placeholders-for-filters or operators to the simplifiedLine
        parts.forEach((part, _index) => {
            // Check if the part is an operator by matching against the regex without surrounding parentheses
            if (!BooleanField.isAFilter(part, delimiters)) {
                // It's an operator, space or parenthesis, so add it directly to the simplifiedLine
                simplifiedLine += `${part}`;
            } else {
                // It's a filter, replace it with a placeholder, and save it:
                const placeholder = `f${currentIndex}`;
                filters[placeholder] = part;
                simplifiedLine += placeholder;
                currentIndex++;
            }
        });

        return { simplifiedLine, filters };
    }

    private static isAFilter(part: string, delimiters: BooleanDelimiters) {
        // These *could* be inlined, but their variable names add meaning.
        // TODO Simplify the expressions
        // TODO Clarify the variable names
        const onlySpacesAndParentheses = new RegExp(
            '^' + anyOfTheseChars(' ' + delimiters.openAndCloseFilterChars) + '+$',
        );

        const binaryOperatorAndParentheses = new RegExp(
            '^ *' + delimiters.closeFilter + ' *(AND|OR|XOR) *' + delimiters.openFilter + ' *$',
        );

        const unaryOperatorAndParentheses = new RegExp('^(AND|OR|XOR|NOT) *' + delimiters.openFilter + '$');

        const remnantsOfNot = new RegExp('^' + delimiters.closeFilter + ' *(AND|OR|XOR)$');

        const justOperators = /^(AND|OR|XOR|NOT)$/;

        return ![
            onlySpacesAndParentheses,
            binaryOperatorAndParentheses,
            unaryOperatorAndParentheses,
            remnantsOfNot,
            justOperators,
        ].some((regex) => RegExp(regex).exec(part));
    }

    /*
     * This run a Task object through a complete boolean expression.
     * It basically resolves the postfix expression until it is reduced into a single boolean value,
     * which is the result of the complete expression.
     * See here how it works: http://www.btechsmartclass.com/data_structures/postfix-evaluation.html
     * Another reference: https://www.tutorialspoint.com/Evaluate-Postfix-Expression
     */
    private filterTaskWithParsedQuery(
        task: Task,
        postfixExpression: PostfixExpression,
        searchInfo: SearchInfo,
    ): boolean {
        const toBool = (s: string | undefined) => {
            return s === 'true';
        };
        const toString = (b: boolean) => {
            return b ? 'true' : 'false';
        };
        const booleanStack: string[] = [];
        for (const token of postfixExpression) {
            if (token.name === 'IDENTIFIER') {
                // Identifiers are the sub-fields of the expression, the actual filters, e.g. 'description includes foo'.
                // For each identifier we created earlier the corresponding Filter, so now we can just evaluate the given
                // task for each identifier that we find in the postfix expression.
                if (token.value == null) throw Error('null token value'); // This should not happen
                const filter = this.subFields[token.value.trim()];
                const result = filter.filterFunction(task, searchInfo);
                booleanStack.push(toString(result));
            } else if (token.name === 'OPERATOR') {
                // To evaluate an operator we need to pop the required number of items from the boolean stack,
                // do the logical evaluation and push back the result
                if (token.value === 'NOT') {
                    const arg1 = toBool(booleanStack.pop());
                    booleanStack.push(toString(!arg1));
                } else if (token.value === 'OR') {
                    const arg1 = toBool(booleanStack.pop());
                    const arg2 = toBool(booleanStack.pop());
                    booleanStack.push(toString(arg1 || arg2));
                } else if (token.value === 'AND') {
                    const arg1 = toBool(booleanStack.pop());
                    const arg2 = toBool(booleanStack.pop());
                    booleanStack.push(toString(arg1 && arg2));
                } else if (token.value === 'XOR') {
                    const arg1 = toBool(booleanStack.pop());
                    const arg2 = toBool(booleanStack.pop());
                    booleanStack.push(toString((arg1 && !arg2) || (!arg1 && arg2)));
                } else {
                    throw Error('Unsupported operator: ' + token.value);
                }
            } else {
                throw Error('Unsupported token type: ' + token);
            }
        }
        // Eventually the result of the expression for this Task is the only item left in the boolean stack
        return toBool(booleanStack[0]);
    }

    /**
     * Construct an {@link Explanation} representing the complete Boolean instruction currently being analysed.
     *
     * @param postfixExpression
     */
    private constructExplanation(postfixExpression: PostfixExpression): Explanation {
        // For an explanation of the code, see the JSdoc and comments of filterTaskWithParsedQuery()
        const explanationStack: Explanation[] = [];
        for (const token of postfixExpression) {
            if (token.name === 'IDENTIFIER') {
                this.explainExpression(token, explanationStack);
            } else if (token.name === 'OPERATOR') {
                this.explainOperator(token, explanationStack);
            } else {
                throw Error('Unsupported token type: ' + token.name);
            }
        }
        // Eventually the Explanation is the only item left in the boolean stack
        return explanationStack[0];
    }

    private explainExpression(token: Token, explanationStack: Explanation[]) {
        if (token.value == null) {
            throw Error('null token value'); // This should not happen
        }
        const filter = this.subFields[token.value.trim()];
        const explanation = this.simulateExplainFilter(filter);
        explanationStack.push(explanation);
    }

    private simulateExplainFilter(filter: Filter) {
        // In our caller, the explanationStack keeps the explanations but not the instruction lines.
        // So to replicate the logic in Filter.explainFilterIndented(), we may need to add the
        // instruction to the explanation.
        return filter.simulateExplainFilter();
    }

    private explainOperator(token: Token, explanationStack: Explanation[]) {
        // To evaluate an operator we need to pop the required number of items from the boolean stack,
        // do the logical evaluation and push back the result
        if (token.value === 'NOT') {
            const arg1 = explanationStack.pop();
            explanationStack.push(Explanation.booleanNot([arg1!]));
        } else if (token.value === 'OR') {
            const arg2 = explanationStack.pop();
            const arg1 = explanationStack.pop();
            explanationStack.push(Explanation.booleanOr([arg1!, arg2!]));
        } else if (token.value === 'AND') {
            const arg2 = explanationStack.pop();
            const arg1 = explanationStack.pop();
            explanationStack.push(Explanation.booleanAnd([arg1!, arg2!]));
        } else if (token.value === 'XOR') {
            const arg2 = explanationStack.pop();
            const arg1 = explanationStack.pop();
            explanationStack.push(Explanation.booleanXor([arg1!, arg2!]));
        } else {
            throw Error('Unsupported operator: ' + token.value);
        }
    }
}

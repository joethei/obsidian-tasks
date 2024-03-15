/**
 * A single logical input statement in a Tasks Query block.
 *
 * This may represent multiple lines with continuation characters.
 *
 * {@link anyContinuationLinesRemoved} is the final line, after continuation lines have been applied.
 * If continuation lines were used, {@link rawInstruction} represents the multi-line input.
 */
export class Statement {
    public readonly rawInstruction: string;
    public readonly anyContinuationLinesRemoved: string;

    /**
     *
     * @param rawInstruction - If the query used continuation lines for this statement, rawInstruction represents the multi-line input.
     * @param instruction - whitespace is trimmed
     */
    constructor(rawInstruction: string, instruction: string) {
        this.rawInstruction = rawInstruction;
        this.anyContinuationLinesRemoved = instruction.trim();
    }
}

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  frontmatter: Record<string, unknown> | null;
}

export function validateSkillDirectory(skillDir: string): Promise<SkillValidationResult>;
export declare function main(argv?: string[]): Promise<void>;

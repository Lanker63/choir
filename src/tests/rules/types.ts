export type RuleTest = {
  input: string;
  expectedViolations: number;
  expectedOutput?: string;
};

export type RuleGoldenExpectations = {
  expectedViolations: number;
  expectedStructureDiff?: {
    removedNodeIds: string[];
    addedNodeIds: string[];
  };
};

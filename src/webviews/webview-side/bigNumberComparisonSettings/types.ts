export interface BigNumberComparisonSettings {
    enabled: boolean;
    comparisonType: 'percentage-change' | 'absolute-value' | '';
    comparisonValue: string;
    comparisonTitle: string;
    comparisonFormat: string;
}

export type WebviewMessage =
    | { type: 'init'; settings: BigNumberComparisonSettings }
    | { type: 'save'; settings: BigNumberComparisonSettings }
    | { type: 'locInit'; locStrings: Record<string, string> }
    | { type: 'cancel' };


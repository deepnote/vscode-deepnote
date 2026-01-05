import { format } from 'd3-format';

export const numberFormats: Record<
    string,
    {
        label: string;
        formatter: (value: number | null, decimals: number | null) => string | null;
    }
> = {
    default: { label: 'Default', formatter: (value) => value?.toString() ?? null },
    number: { label: 'Number', formatter: (value, decimals) => (value ? format(`.${decimals ?? 2}f`)(value) : null) },
    scientific: {
        label: 'Scientific',
        formatter: (value, decimals) => (value ? format(`.${decimals ?? 2}e`)(value) : null)
    },
    percent: { label: 'Percent', formatter: (value, decimals) => (value ? format(`.${decimals ?? 0}%`)(value) : null) }
};

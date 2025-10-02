import type { BlockConverter } from './blockConverter';

export class ConverterRegistry {
    private readonly typeToConverterMap: Map<string, BlockConverter> = new Map();

    findConverter(blockType: string): BlockConverter | undefined {
        return this.typeToConverterMap.get(blockType.toLowerCase());
    }

    listSupportedTypes(): string[] {
        return Array.from(this.typeToConverterMap.keys()).sort();
    }

    register(converter: BlockConverter): void {
        converter.getSupportedTypes().forEach((type) => {
            this.typeToConverterMap.set(type, converter);
        });
    }
}

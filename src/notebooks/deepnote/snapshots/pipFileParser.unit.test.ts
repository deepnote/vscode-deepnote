import { assert } from 'chai';

import { parsePipFreezeFile } from './pipFileParser';

suite('pipFileParser', () => {
    suite('parsePipFreezeFile', () => {
        test('should parse standard package==version format', () => {
            const content = `anyio==4.12.0
pandas==2.3.2
numpy==2.0.2`;

            const result = parsePipFreezeFile(content);

            assert.deepStrictEqual(result, {
                anyio: '4.12.0',
                pandas: '2.3.2',
                numpy: '2.0.2'
            });
        });

        test('should handle @ file URL format', () => {
            const content = `altgraph @ file:///AppleInternal/Library/BuildRoots/39d9dc1a-2111-11f0-be06-226177e5bb69/Library/Caches/com.apple.xbs/Sources/python3/altgraph-0.17.2-py2.py3-none-any.whl
deepnote-format @ file:///Users/artmann/deepnote/format
numpy==2.0.2`;

            const result = parsePipFreezeFile(content);

            assert.strictEqual(
                result['altgraph'],
                'file:///AppleInternal/Library/BuildRoots/39d9dc1a-2111-11f0-be06-226177e5bb69/Library/Caches/com.apple.xbs/Sources/python3/altgraph-0.17.2-py2.py3-none-any.whl'
            );
            assert.strictEqual(result['deepnote-format'], 'file:///Users/artmann/deepnote/format');
            assert.strictEqual(result['numpy'], '2.0.2');
        });

        test('should handle empty input', () => {
            const result = parsePipFreezeFile('');

            assert.deepStrictEqual(result, {});
        });

        test('should skip editable installs (-e)', () => {
            const content = `-e git+https://github.com/user/repo.git@abc123#egg=mypackage
numpy==2.0.2
-e .`;

            const result = parsePipFreezeFile(content);

            assert.deepStrictEqual(result, {
                numpy: '2.0.2'
            });
        });

        test('should skip comments', () => {
            const content = `# This is a comment
numpy==2.0.2
# Another comment
pandas==2.3.2`;

            const result = parsePipFreezeFile(content);

            assert.deepStrictEqual(result, {
                numpy: '2.0.2',
                pandas: '2.3.2'
            });
        });

        test('should normalize package names to lowercase', () => {
            const content = `NumPy==2.0.2
Pandas==2.3.2
PyYAML==6.0.2
SQLAlchemy==2.0.43`;

            const result = parsePipFreezeFile(content);

            assert.strictEqual(result['numpy'], '2.0.2');
            assert.strictEqual(result['pandas'], '2.3.2');
            assert.strictEqual(result['pyyaml'], '6.0.2');
            assert.strictEqual(result['sqlalchemy'], '2.0.43');
        });

        test('should skip blank lines', () => {
            const content = `numpy==2.0.2

pandas==2.3.2

`;

            const result = parsePipFreezeFile(content);

            assert.deepStrictEqual(result, {
                numpy: '2.0.2',
                pandas: '2.3.2'
            });
        });

        test('should handle packages with hyphens and underscores', () => {
            const content = `python-dateutil==2.9.0.post0
typing_extensions==4.15.0
snowflake-connector-python==3.17.4`;

            const result = parsePipFreezeFile(content);

            assert.strictEqual(result['python-dateutil'], '2.9.0.post0');
            assert.strictEqual(result['typing_extensions'], '4.15.0');
            assert.strictEqual(result['snowflake-connector-python'], '3.17.4');
        });

        test('should handle complex version strings', () => {
            const content = `python-dateutil==2.9.0.post0
urllib3==1.26.20
msgspec_m==0.19.3`;

            const result = parsePipFreezeFile(content);

            assert.strictEqual(result['python-dateutil'], '2.9.0.post0');
            assert.strictEqual(result['urllib3'], '1.26.20');
            assert.strictEqual(result['msgspec_m'], '0.19.3');
        });

        test('should handle Windows-style line endings', () => {
            const content = `numpy==2.0.2\r\npandas==2.3.2\r\n`;

            const result = parsePipFreezeFile(content);

            assert.deepStrictEqual(result, {
                numpy: '2.0.2',
                pandas: '2.3.2'
            });
        });

        test('should handle real-world pip freeze output', () => {
            const content = `altgraph @ file:///AppleInternal/Library/BuildRoots/39d9dc1a-2111-11f0-be06-226177e5bb69/Library/Caches/com.apple.xbs/Sources/python3/altgraph-0.17.2-py2.py3-none-any.whl
anyio==4.12.0
boto3==1.40.43
deepnote-format @ file:///Users/artmann/deepnote/format
numpy==2.0.2
pandas==2.3.2
python-dateutil==2.9.0.post0
six @ file:///AppleInternal/Library/BuildRoots/39d9dc1a-2111-11f0-be06-226177e5bb69/Library/Caches/com.apple.xbs/Sources/python3/six-1.15.0-py2.py3-none-any.whl
SQLAlchemy==2.0.43
typing_extensions==4.15.0`;

            const result = parsePipFreezeFile(content);

            assert.strictEqual(Object.keys(result).length, 10);
            assert.strictEqual(result['anyio'], '4.12.0');
            assert.strictEqual(result['boto3'], '1.40.43');
            assert.strictEqual(result['numpy'], '2.0.2');
            assert.strictEqual(result['pandas'], '2.3.2');
            assert.strictEqual(result['python-dateutil'], '2.9.0.post0');
            assert.strictEqual(result['sqlalchemy'], '2.0.43');
            assert.strictEqual(result['typing_extensions'], '4.15.0');
            assert.ok(result['altgraph'].startsWith('file:///'));
            assert.ok(result['deepnote-format'].startsWith('file:///'));
            assert.ok(result['six'].startsWith('file:///'));
        });
    });
});

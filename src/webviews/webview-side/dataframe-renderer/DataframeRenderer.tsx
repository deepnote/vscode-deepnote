import * as React from 'react';

interface DataframeRendererProps {
    data: any;
}

export const DataframeRenderer: React.FC<DataframeRendererProps> = ({ data }) => {
    console.log('DataframeRenderer', data);

    return <div className="dataframe-container">This is the Deepnote dataframe renderer</div>;
};

import * as vscode from 'vscode';

const TEMPLATES: Record<string, string> = {
    rowTable:
        "CREATE TABLE `<table_name>` (\n" +
        "    column1 Utf8 NOT NULL,\n" +
        "    column2 Int64,\n" +
        "    PRIMARY KEY (column1)\n" +
        ");",

    columnTable:
        "CREATE TABLE `<table_name>` (\n" +
        "    column1 Uint64 NOT NULL,\n" +
        "    column2 Timestamp NOT NULL,\n" +
        "    column3 Utf8,\n" +
        "    PRIMARY KEY (column1, column2)\n" +
        ")\n" +
        "PARTITION BY HASH(column1)\n" +
        "WITH (STORE = COLUMN);",

    topic:
        "CREATE TOPIC `<topic_name>` (\n" +
        "    CONSUMER consumer1\n" +
        ") WITH (\n" +
        "    min_active_partitions = 1,\n" +
        "    retention_period = Interval('PT24H')\n" +
        ");",

    view:
        "CREATE VIEW `<view_name>` WITH (security_invoker = TRUE) AS\n" +
        "    SELECT * FROM `<table_name>`;",

    extDsObjectStorage:
        "CREATE EXTERNAL DATA SOURCE `<name>` WITH (\n" +
        "    SOURCE_TYPE=\"ObjectStorage\",\n" +
        "    LOCATION=\"https://<endpoint>/<bucket>/\",\n" +
        "    AUTH_METHOD=\"AWS\",\n" +
        "    AWS_ACCESS_KEY_ID_SECRET_NAME=\"<access_key_id_secret>\",\n" +
        "    AWS_SECRET_ACCESS_KEY_SECRET_NAME=\"<secret_access_key_secret>\",\n" +
        "    AWS_REGION=\"<region>\"\n" +
        ");",

    extDsYdb:
        "CREATE EXTERNAL DATA SOURCE `<name>` WITH (\n" +
        "    SOURCE_TYPE=\"Ydb\",\n" +
        "    LOCATION=\"<host>:<port>\",\n" +
        "    DATABASE_NAME=\"<database>\",\n" +
        "    AUTH_METHOD=\"BASIC\",\n" +
        "    LOGIN=\"<login>\",\n" +
        "    PASSWORD_SECRET_NAME=\"<secret_name>\",\n" +
        "    USE_TLS=\"TRUE\"\n" +
        ");",

    extTableCsv:
        "CREATE EXTERNAL TABLE `<table_name>` (\n" +
        "    column1 Utf8 NOT NULL,\n" +
        "    column2 Int64\n" +
        ") WITH (\n" +
        "    DATA_SOURCE=\"<data_source_name>\",\n" +
        "    LOCATION=\"<path>\",\n" +
        "    FORMAT=\"csv_with_names\"\n" +
        ");",

    extTableJson:
        "CREATE EXTERNAL TABLE `<table_name>` (\n" +
        "    column1 Utf8 NOT NULL,\n" +
        "    column2 Int64\n" +
        ") WITH (\n" +
        "    DATA_SOURCE=\"<data_source_name>\",\n" +
        "    LOCATION=\"<path>\",\n" +
        "    FORMAT=\"json_each_row\"\n" +
        ");",

    extTableParquet:
        "CREATE EXTERNAL TABLE `<table_name>` (\n" +
        "    column1 Utf8 NOT NULL,\n" +
        "    column2 Int64\n" +
        ") WITH (\n" +
        "    DATA_SOURCE=\"<data_source_name>\",\n" +
        "    LOCATION=\"<path>\",\n" +
        "    FORMAT=\"parquet\"\n" +
        ");",

    transfer:
        "$transformation_lambda = ($msg) -> {\n" +
        "    return [\n" +
        "        <|\n" +
        "            partition: $msg._partition,\n" +
        "            offset: $msg._offset,\n" +
        "            message: CAST($msg._data AS Utf8)\n" +
        "        |>\n" +
        "    ];\n" +
        "};\n" +
        "\n" +
        "CREATE TRANSFER `<transfer_name>`\n" +
        "    FROM `<topic_name>` TO `<table_name>` USING $transformation_lambda;",

    streamingQuery:
        "CREATE STREAMING QUERY `<query_name>` WITH (\n" +
        "    RUN = TRUE\n" +
        ") AS\n" +
        "DO BEGIN\n" +
        "    -- query statements here\n" +
        "END DO",
};

async function openTemplate(key: string): Promise<void> {
    const template = TEMPLATES[key];
    if (!template) {
        return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: template, language: 'yql' });
    await vscode.window.showTextDocument(doc, { preview: false });
}

export function registerCreateCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('ydb.createRowTable', () => openTemplate('rowTable')),
        vscode.commands.registerCommand('ydb.createColumnTable', () => openTemplate('columnTable')),
        vscode.commands.registerCommand('ydb.createTopic', () => openTemplate('topic')),
        vscode.commands.registerCommand('ydb.createView', () => openTemplate('view')),
        vscode.commands.registerCommand('ydb.createExtDsObjectStorage', () => openTemplate('extDsObjectStorage')),
        vscode.commands.registerCommand('ydb.createExtDsYdb', () => openTemplate('extDsYdb')),
        vscode.commands.registerCommand('ydb.createExtTableCsv', () => openTemplate('extTableCsv')),
        vscode.commands.registerCommand('ydb.createExtTableJson', () => openTemplate('extTableJson')),
        vscode.commands.registerCommand('ydb.createExtTableParquet', () => openTemplate('extTableParquet')),
        vscode.commands.registerCommand('ydb.createTransfer', () => openTemplate('transfer')),
        vscode.commands.registerCommand('ydb.createStreamingQuery', () => openTemplate('streamingQuery')),
    );
}

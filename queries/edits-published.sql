-- Geo Protocol EditsPublished Events Query
-- 
-- This query extracts and decodes EditsPublished events from Space plugin contracts
-- Event signature: EditsPublished(address indexed dao, string editsContentUri, bytes editsMetadata)

SELECT 
    block_num,
    timestamp,
    tx_hash,
    log_index,
    address as space_plugin_address,
    evm_decode_hex(topic1) as dao_address,
    evm_decode_log(
        topic1, topic2, topic3, data,
        'EditsPublished(address indexed dao, string editsContentUri, bytes editsMetadata)'
    ) as decoded
FROM "_/geo_testnet".logs
WHERE topic0 = evm_topic('EditsPublished(address indexed dao, string editsContentUri, bytes editsMetadata)')
ORDER BY block_num DESC, log_index DESC
LIMIT 100;

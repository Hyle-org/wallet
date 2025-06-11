import React, { useState } from "react";
import { useWallet, verifyIdentity } from "hyli-wallet";
import { blob_builder, BlobTransaction } from "hyli";
import { build_proof_transaction, build_blob as check_secret_blob } from "hyli-check-secret";
import { nodeService } from "../services/NodeService";
import { indexerService } from "../services/IndexerService";
import { BorshSchema, borshSerialize } from "borsher";

const as_structured = (schema: BorshSchema<any>) => {
    return BorshSchema.Struct({
        caller: BorshSchema.Option(BorshSchema.u64),
        callees: BorshSchema.Option(BorshSchema.Vec(BorshSchema.u64)),
        parameters: schema,
    })
};

const deleteContractActionSchema = as_structured(BorshSchema.Struct({
    contract_name: BorshSchema.String,
}));

function serializeDeleteContractAction(contractName: string): Uint8Array {
    return borshSerialize(deleteContractActionSchema, { parameters: { contract_name: contractName }, caller: null, callees: null });
}

const nukeTxActionSchema = as_structured(BorshSchema.Struct({
    tx_hashes: BorshSchema.Vec(BorshSchema.String),
}));

function serializeNukeTxAction(txHashes: string[]): Uint8Array {
    return borshSerialize(nukeTxActionSchema, { parameters: { tx_hashes: txHashes }, caller: null, callees: null });
}

const INIT_TRANSFERS = [
    { to: "faucet", token: "oranj", amount: BigInt(1_000_000_000) },
    { to: "blackjack", token: "vitamin", amount: BigInt(1_000_000) },
    { to: "board_game", token: "oxygen", amount: BigInt(1_000_000_000) },
];

type PendingAction = null | {
    type: 'delete' | 'nuke' | 'init',
    value: string,
    timeoutId: NodeJS.Timeout
};

const AdminPage: React.FC = () => {
    const { wallet } = useWallet();
    const [status, setStatus] = useState<string>("");
    const [error, setError] = useState<unknown>(null);
    const [contractName, setContractName] = useState<string>("");
    const [txHashes, setTxHashes] = useState<string>("");
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [result, setResult] = useState<string>("");
    const [pendingAction, setPendingAction] = useState<PendingAction>(null);
    const [password, setPassword] = useState<string>("");
    const [showPassword, setShowPassword] = useState<boolean>(false);
    const [pendingSeconds, setPendingSeconds] = useState<number>(5);

    if (!wallet) return null;

    // Helper to clear pending action
    const clearPending = () => {
        if (pendingAction) {
            clearTimeout(pendingAction.timeoutId);
            setPendingAction(null);
            setStatus("");
        }
    };

    // Generic admin action sender
    const sendAdminAction = async (actionType: 'init' | 'delete' | 'nuke', value?: string) => {
        setError(null);
        setIsLoading(true);
        try {
            const accountInfo = await indexerService.getAccountInfo(wallet.username);
            const salted_password = `${password}:${accountInfo.salt}`;
            const blob1 = verifyIdentity(wallet.username, Date.now());
            const identity = `${wallet.username}@${blob1.contract_name}`;
            const blob0 = await check_secret_blob(identity, salted_password);
            let blobs = [blob0, blob1];
            if (actionType === 'init') {
                for (const t of INIT_TRANSFERS) {
                    blobs.push(blob_builder.smt_token.transfer(identity, t.to, t.token, t.amount, null));
                }
                setResult(JSON.stringify(INIT_TRANSFERS, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
            } else if (actionType === 'delete' && value) {
                const action = serializeDeleteContractAction(value);
                setResult(`DeleteContractAction: ${value}`);
                const actionBlob = { contract_name: "hyle", data: Array.from(action) };
                blobs = [blob0, blob1, actionBlob];
            } else if (actionType === 'nuke' && value) {
                const hashes = value.split(",").map((h) => h.trim()).filter(Boolean);
                const action = serializeNukeTxAction(hashes);
                setResult(`NukeTxAction: ${hashes.join(", ")}`);
                const actionBlob = { contract_name: "hyle", data: Array.from(action) };
                blobs = [blob0, blob1, actionBlob];
            }
            setStatus(`Sending ${actionType === 'init' ? 'Init' : actionType === 'delete' ? 'DeleteContract' : 'NukeTx'} transaction...`);
            const blobTx: BlobTransaction = { identity, blobs };
            const tx_hash = await nodeService.client.sendBlobTx(blobTx);
            setStatus("Building proof transaction...");
            const proofTx = await build_proof_transaction(identity, salted_password, tx_hash, 0, blobTx.blobs.length);
            setStatus("Sending proof transaction...");
            await nodeService.client.sendProofTx(proofTx);
            setStatus(`${actionType === 'init' ? 'Init' : actionType === 'delete' ? 'DeleteContract' : 'NukeTx'} transaction sent!`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setStatus("");
        } finally {
            setIsLoading(false);
        }
    };

    const handleInit = async () => {
        setError(null);
        setStatus("");
        setIsLoading(true);
        clearPending();
        const timeoutId = setTimeout(async () => {
            setPendingAction(null);
            await sendAdminAction('init');
        }, 5000);
        setPendingAction({ type: 'init', value: '', timeoutId });
        setStatus(`Init will be sent in 5s. Click 'Undo' to cancel.`);
        setIsLoading(false);
    };

    const handleDeleteContract = async () => {
        setError(null);
        setStatus("");
        setIsLoading(true);
        // Only allow one pending action at a time
        clearPending();
        const timeoutId = setTimeout(async () => {
            setPendingAction(null);
            await sendAdminAction('delete', contractName);
        }, 5000);
        setPendingAction({ type: 'delete', value: contractName, timeoutId });
        setStatus(`DeleteContract will be sent in 5s. Click 'Undo' to cancel.`);
        setIsLoading(false);
    };

    const handleNukeTx = async () => {
        setError(null);
        setStatus("");
        setIsLoading(true);
        // Only allow one pending action at a time
        clearPending();
        const timeoutId = setTimeout(async () => {
            setPendingAction(null);
            await sendAdminAction('nuke', txHashes);
        }, 5000);
        setPendingAction({ type: 'nuke', value: txHashes, timeoutId });
        setStatus(`NukeTx will be sent in 5s. Click 'Undo' to cancel.`);
        setIsLoading(false);
    };

    React.useEffect(() => {
        if (!pendingAction) return;
        setPendingSeconds(5);
        const interval = setInterval(() => {
            setPendingSeconds((s) => {
                if (!pendingAction) return 5;
                if (s <= 1) {
                    clearInterval(interval);
                    return 0;
                }
                return s - 1;
            });
        }, 1000);
        return () => clearInterval(interval);
    }, [pendingAction]);

    return (
        <div style={{ padding: 32 }}>
            <h1>Admin Panel</h1>
            <p>Welcome, admin! Here you can perform special actions.</p>
            <div className="card" style={{ margin: '2rem 0', maxWidth: 600 }}>
                <h3 className="card-title">Init Payload</h3>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 16 }}>
                    <thead>
                        <tr style={{ borderBottom: '1px solid #eee' }}>
                            <th style={{ textAlign: 'left', padding: '8px' }}>Token</th>
                            <th style={{ textAlign: 'left', padding: '8px' }}>Amount</th>
                            <th style={{ textAlign: 'left', padding: '8px' }}>Recipient</th>
                        </tr>
                    </thead>
                    <tbody>
                        {INIT_TRANSFERS.map((t, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid #f5f5f5' }}>
                                <td style={{ padding: '8px' }}>{t.token.toUpperCase()}</td>
                                <td style={{ padding: '8px' }}>{t.amount.toString()}</td>
                                <td style={{ padding: '8px' }}>{t.to}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div style={{ flex: 1, maxWidth: 320, marginBottom: 32 }}>
                    <input
                        className="input"
                        type={showPassword ? "text" : "password"}
                        placeholder="Enter your password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        style={{ width: '100%' }}
                    />
                    <button
                        type="button"
                        onClick={() => setShowPassword(v => !v)}
                        style={{
                            position: "absolute",
                            right: 10,
                            top: 10,
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            color: "#aaa"
                        }}
                        tabIndex={-1}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                        {showPassword ? "🙈" : "👁️"}
                    </button>
                </div>
            <div className="form-group" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <button className="btn-primary" style={{ minWidth: 180 }} onClick={handleInit} disabled={isLoading || !password}>
                    Init (preconfigured transfers)
                </button>
            </div>
            <div className="form-group" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <input
                    className="input"
                    type="text"
                    placeholder="Contract name to delete"
                    value={contractName}
                    onChange={(e) => setContractName(e.target.value)}
                    style={{ maxWidth: 320 }}
                />
                <button className="btn-primary" style={{ minWidth: 180 }} onClick={handleDeleteContract} disabled={isLoading || !contractName || !password}>
                    Delete Contract
                </button>
            </div>
            {/*
            <div className="form-group" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <input
                    className="input"
                    type="text"
                    placeholder="Comma-separated TX hashes to nuke"
                    value={txHashes}
                    onChange={(e) => setTxHashes(e.target.value)}
                    style={{ maxWidth: 320 }}
                />
                <button className="btn-primary" style={{ minWidth: 180 }} onClick={handleNukeTx} disabled={isLoading || !txHashes || !password}>
                    Nuke TX
                </button>
            </div>
            */}
            {status && <div>Status: {status}</div>}
            {pendingAction && (
                <div style={{ margin: '1rem 0', color: '#DFA445', fontWeight: 500 }}>
                    Action will be sent in {pendingSeconds} second{pendingSeconds !== 1 ? 's' : ''}.{' '}
                    <button style={{ color: '#DFA445', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }} onClick={clearPending}>Undo</button>
                </div>
            )}
            {error ? <div style={{ color: 'red' }}>Error: {String(error)}</div> : null}
        </div>
    );
};

export default AdminPage; 
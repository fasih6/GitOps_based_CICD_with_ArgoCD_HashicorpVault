# HashiCorp Vault Setup — 3-Tier Node.js App

A complete guide to installing, configuring, and integrating HashiCorp Vault with Kubernetes (EKS) using the External Secrets Operator (ESO).

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Install Vault on Kubernetes](#3-install-vault-on-kubernetes)
4. [Initialize and Unseal Vault](#4-initialize-and-unseal-vault)
5. [Configure Vault](#5-configure-vault)
6. [Install External Secrets Operator](#6-install-external-secrets-operator)
7. [Connect ESO to Vault](#7-connect-eso-to-vault)
8. [Verify the Full Chain](#8-verify-the-full-chain)
9. [Updating Secrets](#9-updating-secrets)
10. [Common Troubleshooting](#10-common-troubleshooting)

---

## 1. Architecture Overview

```
HashiCorp Vault (running in vault namespace)
  └── KV v2 secrets engine at path: secret/
        └── secret/prod/mysql
              └── MYSQL_ROOT_PASSWORD = "your-password"
                        │
                        │  Kubernetes Auth (service account token)
                        ▼
            External Secrets Operator
            (running in external-secrets namespace)
                        │
              ClusterSecretStore ──── polls Vault every 1h
                        │
              ExternalSecret
                        │
                        ▼
            Kubernetes Secret: mysql-secret
            (created in prod namespace)
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
        mysql-0 pod          backend pod
    (MYSQL_ROOT_PASSWORD)  (DB_PASSWORD)
```

### Why this approach?

| Approach | Pros | Cons |
|---|---|---|
| Secret in values.yaml | Simple | Password in git — insecure |
| Vault Agent Injector | Direct Vault integration | Sidecar in every pod, file-based secrets |
| **ESO + Vault (this setup)** | Native K8s Secrets, no app changes needed | Slight extra complexity |

ESO was chosen because the app already reads secrets via `secretKeyRef` — no application code changes were required.

---

## 2. Prerequisites

Before starting, ensure the following are in place:

- Kubernetes cluster running (EKS in this project)
- `kubectl` configured and connected to the cluster
- `helm` v3+ installed
- A storage class available (`gp2` used here)
- The `prod` namespace exists or ArgoCD is configured to create it

Verify your storage classes:

```bash
kubectl get storageclass
```

You should see at least one storage class. Note the name — you will need it when installing Vault.

---

## 3. Install Vault on Kubernetes

### Add the HashiCorp Helm repo

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update
```

### Install Vault

```bash
helm install vault hashicorp/vault \
  --namespace vault \
  --create-namespace \
  --set server.dataStorage.storageClass=gp2 \
  --set server.dataStorage.size=5Gi
```

> **Important:** Always specify `server.dataStorage.storageClass` during install. If you skip it, Vault uses the default storage class which may not exist or may have `WaitForFirstConsumer` binding, causing the pod to stay `Pending`. You cannot change the storage class after installation without uninstalling and deleting the PVC.

### Verify pods are running

```bash
kubectl get pods -n vault -w
```

Expected output:

```
NAME                                   READY   STATUS    RESTARTS   AGE
vault-0                                0/1     Running   0          30s
vault-agent-injector-xxx               1/1     Running   0          30s
```

> `vault-0` shows `0/1` (not ready) at this stage — this is expected. Vault is running but not yet initialized or unsealed. The readiness probe fails until you complete the next step.

---

## 4. Initialize and Unseal Vault

### Initialize Vault

Run this command **once only**. It generates the unseal keys and root token.

```bash
kubectl exec -n vault vault-0 -- vault operator init \
  -key-shares=5 \
  -key-threshold=3
```

You will see output similar to:

```
Unseal Key 1: <key-1>
Unseal Key 2: <key-2>
Unseal Key 3: <key-3>
Unseal Key 4: <key-4>
Unseal Key 5: <key-5>

Initial Root Token: hvs.xxxxxxxxxxxxxxxxx
```

> **Critical:** Save all 5 unseal keys and the root token somewhere secure. You will never see them again. If you lose them, you lose access to Vault permanently.

### Unseal Vault

Vault requires 3 of the 5 unseal keys to unseal (threshold of 3). Run these three commands:

```bash
kubectl exec -n vault vault-0 -- vault operator unseal <unseal-key-1>
kubectl exec -n vault vault-0 -- vault operator unseal <unseal-key-2>
kubectl exec -n vault vault-0 -- vault operator unseal <unseal-key-3>
```

After the third key, `vault-0` becomes `1/1 Ready`:

```bash
kubectl get pods -n vault
# NAME        READY   STATUS    RESTARTS   AGE
# vault-0     1/1     Running   0          5m
```

> **Note:** Vault seals itself automatically if the pod restarts. You must unseal it again with 3 keys every time it restarts. For production use, consider auto-unseal using AWS KMS.

---

## 5. Configure Vault

### Exec into the Vault pod

```bash
kubectl exec -it -n vault vault-0 -- /bin/sh
```

### Login with root token

```bash
vault login <root-token>
```

### Enable Kubernetes authentication

This allows Vault to verify the identity of Kubernetes workloads using their service account tokens.

```bash
vault auth enable kubernetes

vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc"
```

### Enable KV v2 secrets engine

```bash
vault secrets enable -path=secret kv-v2
```

### Store the MySQL password

```bash
vault kv put secret/prod/mysql \
  MYSQL_ROOT_PASSWORD="your-strong-password"
```

Verify it was stored:

```bash
vault kv get secret/prod/mysql
```

### Create an access policy

This policy allows reading any secret under `secret/data/prod/`:

```bash
vault policy write prod-policy - <<EOF
path "secret/data/prod/*" {
  capabilities = ["read"]
}
EOF
```

### Create a Kubernetes auth role for ESO

This role binds the `external-secrets` service account (in the `external-secrets` namespace) to the `prod-policy`.

```bash
vault write auth/kubernetes/role/eso-role \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=prod-policy \
  ttl=1h
```

### Exit the Vault pod

```bash
exit
```

---

## 6. Install External Secrets Operator

ESO is a Kubernetes operator that polls Vault and creates native Kubernetes Secrets automatically.

### Add the ESO Helm repo

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
```

### Install ESO

```bash
helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true
```

### Verify pods are running

```bash
kubectl get pods -n external-secrets
```

Expected output:

```
NAME                                                READY   STATUS    RESTARTS   AGE
external-secrets-xxx                                1/1     Running   0          1m
external-secrets-cert-controller-xxx               1/1     Running   0          1m
external-secrets-webhook-xxx                        1/1     Running   0          1m
```

### Verify CRDs are installed

```bash
kubectl get crds | grep external-secrets
```

You should see entries including `secretstores.external-secrets.io` and `externalsecrets.external-secrets.io`.

Check the API version your cluster uses:

```bash
kubectl api-resources --verbs=list | grep external-secrets
```

> **Important:** Newer versions of ESO use `external-secrets.io/v1` not `v1beta1`. Always check the API version before applying manifests.

---

## 7. Connect ESO to Vault

### Create the ClusterSecretStore

The `ClusterSecretStore` tells ESO how to connect to Vault and authenticate.

```yaml
# secret-store.yaml
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "http://vault.vault.svc.cluster.local:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "eso-role"
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

> **Why `ClusterSecretStore` and not `SecretStore`?**
> A namespaced `SecretStore` in the `prod` namespace cannot reference a service account from the `external-secrets` namespace — the admission webhook blocks it. `ClusterSecretStore` is cluster-scoped and has no such restriction.

```bash
kubectl apply -f secret-store.yaml
```

Verify it is healthy:

```bash
kubectl get clustersecretstore vault-backend
# NAME            AGE   STATUS   CAPABILITIES   READY
# vault-backend   10s   Valid                   True
```

### Create the ExternalSecret

The `ExternalSecret` tells ESO which secret to fetch from Vault and what Kubernetes Secret to create.

```yaml
# external-secret.yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: mysql-external-secret
  namespace: prod
spec:
  refreshInterval: 1h               # ESO re-syncs from Vault every hour
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: mysql-secret              # Name of the Kubernetes Secret to create
    creationPolicy: Owner           # ESO owns and manages this Secret
  data:
    - secretKey: MYSQL_ROOT_PASSWORD        # Key in the Kubernetes Secret
      remoteRef:
        key: secret/prod/mysql              # Path in Vault
        property: MYSQL_ROOT_PASSWORD       # Field in Vault
```

```bash
kubectl apply -f external-secret.yaml
```

Verify it synced successfully:

```bash
kubectl get externalsecret -n prod
# NAME                    STORETYPE      STORE           REFRESH INTERVAL   STATUS         READY
# mysql-external-secret   SecretStore    vault-backend   1h                 SecretSynced   True
```

---

## 8. Verify the Full Chain

### Check the Kubernetes Secret was created

```bash
kubectl get secret mysql-secret -n prod
```

### Decode and verify the value matches Vault

```bash
kubectl get secret mysql-secret -n prod \
  -o jsonpath='{.data.MYSQL_ROOT_PASSWORD}' | base64 -d
```

### Verify MySQL pod is using it

```bash
# Get pod name
kubectl get pods -n prod

# Exec into MySQL and authenticate
kubectl exec -it mysql-0 -n prod -- mysql -u root -p
# Enter your password when prompted
```

If MySQL grants access, the full chain is confirmed:

```
Vault → ESO → mysql-secret (K8s Secret) → mysql-0 pod → MySQL authenticated ✓
```

---

## 9. Updating Secrets

### Update the password in Vault

```bash
kubectl exec -it -n vault vault-0 -- /bin/sh

vault login <root-token>

vault kv put secret/prod/mysql \
  MYSQL_ROOT_PASSWORD="new-strong-password"

exit
```

### Force ESO to sync immediately

By default ESO syncs every `refreshInterval` (1 hour). To force an immediate sync:

```bash
kubectl annotate externalsecret mysql-external-secret \
  -n prod \
  force-sync=$(date +%s) --overwrite
```

### Verify the updated value

```bash
kubectl get secret mysql-secret -n prod \
  -o jsonpath='{.data.MYSQL_ROOT_PASSWORD}' | base64 -d
# Should show: new-strong-password
```

> **Note:** Updating the Kubernetes Secret does not automatically restart pods that are already running. The new password takes effect on the next pod restart. For MySQL specifically, the password in the running database must also be updated separately.

---

## 10. Common Troubleshooting

### Vault pod stuck in Pending

```
Warning  FailedScheduling  pod has unbound immediate PersistentVolumeClaims
```

**Cause:** Storage class not specified or doesn't exist.

**Fix:** Uninstall, delete the PVC, and reinstall with the correct storage class:

```bash
helm uninstall vault -n vault
kubectl delete pvc data-vault-0 -n vault
helm install vault hashicorp/vault \
  --namespace vault \
  --set server.dataStorage.storageClass=gp2 \
  --set server.dataStorage.size=5Gi
```

---

### Vault pod Running but 0/1 (not ready)

**Cause:** Normal — Vault is running but not yet initialized and unsealed.

**Fix:** Complete [Section 4](#4-initialize-and-unseal-vault).

---

### ClusterSecretStore — InvalidProviderConfig

```
cannot get Kubernetes service account "external-secrets": ServiceAccount not found
```

**Cause:** The service account namespace is not specified, so ESO looks in the wrong namespace.

**Fix:** Add `namespace: external-secrets` to `serviceAccountRef` in your `ClusterSecretStore`.

---

### ExternalSecret — SecretSyncedError

**Cause:** ESO can reach the SecretStore but Vault returned an error (wrong path, wrong role, policy too restrictive).

**Fix:** Describe the ExternalSecret for details:

```bash
kubectl describe externalsecret mysql-external-secret -n prod
```

Then verify inside Vault:

```bash
kubectl exec -it -n vault vault-0 -- /bin/sh
vault login <root-token>
vault kv get secret/prod/mysql         # Confirm path exists
vault read auth/kubernetes/role/eso-role  # Confirm role is configured
exit
```

---

### ESO CRD not found when applying manifests

```
error: no matches for kind "SecretStore" in version "external-secrets.io/v1beta1"
```

**Cause:** Either CRDs are not installed, or you are using the wrong API version.

**Fix:**

```bash
# Check installed API version
kubectl api-resources --verbs=list | grep external-secrets

# Reinstall with CRDs enabled
helm upgrade external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --set installCRDs=true
```

Use whatever version appears in the `api-resources` output in your manifests (likely `external-secrets.io/v1`).

---

### Vault seals after pod restart

**Cause:** This is by design. Vault seals itself on every restart for security.

**Fix:** Unseal again with 3 of your 5 keys:

```bash
kubectl exec -n vault vault-0 -- vault operator unseal <key-1>
kubectl exec -n vault vault-0 -- vault operator unseal <key-2>
kubectl exec -n vault vault-0 -- vault operator unseal <key-3>
```

For production, configure **auto-unseal** using AWS KMS to avoid this:

```bash
helm upgrade vault hashicorp/vault \
  --namespace vault \
  --set server.seal.awskms.enabled=true \
  --set server.seal.awskms.kmsKeyId=<your-kms-key-id> \
  --set server.seal.awskms.region=us-east-1
```

---

*This Vault setup is part of a DevSecOps project using Jenkins, SonarQube, Trivy, Gitleaks, ArgoCD, and External Secrets Operator on AWS EKS.*

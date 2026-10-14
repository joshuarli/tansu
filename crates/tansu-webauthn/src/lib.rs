
use base64ct::{Base64UrlUnpadded, Encoding};
use graviola::hashing::{Hash, Sha256};
use graviola::signing::ecdsa::{P256, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::fmt;

const MAX_CLIENT_DATA_BYTES: usize = 65_536;
const MAX_ATTESTATION_BYTES: usize = 1_048_576;
const MAX_AUTHENTICATOR_DATA_BYTES: usize = 1_048_576;
const MAX_CREDENTIAL_ID_BYTES: usize = 1_024;
const MAX_SIGNATURE_BYTES: usize = 1_024;
const MAX_USER_HANDLE_BYTES: usize = 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebAuthnError {
    InvalidClientData(String),
    ChallengeMismatch,
    OriginMismatch(String),
    InvalidAttestation(String),
    InvalidAuthData(String),
    CredentialNotFound,
    InvalidSignature,
    InvalidPublicKey(String),
    InvalidCoseKey(String),
    DecodeError(String),
    RandomSource(String),
}

impl fmt::Display for WebAuthnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidClientData(e) => write!(f, "invalid client data: {e}"),
            Self::ChallengeMismatch => write!(f, "challenge mismatch"),
            Self::OriginMismatch(o) => write!(f, "origin mismatch: {o}"),
            Self::InvalidAttestation(e) => write!(f, "invalid attestation: {e}"),
            Self::InvalidAuthData(e) => write!(f, "invalid auth data: {e}"),
            Self::CredentialNotFound => write!(f, "credential not found"),
            Self::InvalidSignature => write!(f, "signature verification failed"),
            Self::InvalidPublicKey(e) => write!(f, "invalid public key: {e}"),
            Self::InvalidCoseKey(e) => write!(f, "invalid COSE key: {e}"),
            Self::DecodeError(e) => write!(f, "decode error: {e}"),
            Self::RandomSource(e) => write!(f, "random source failed: {e}"),
        }
    }
}

impl std::error::Error for WebAuthnError {}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RPInfo {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub display_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PubKeyCredParam {
    #[serde(rename = "type")]
    pub cred_type: String,
    pub alg: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatorSelection {
    pub resident_key: String,
    pub require_resident_key: bool,
    pub user_verification: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublicKeyCredentialCreationOptions {
    pub rp: RPInfo,
    pub user: UserInfo,
    pub challenge: String,
    pub pub_key_cred_params: Vec<PubKeyCredParam>,
    pub timeout: u32,
    pub authenticator_selection: AuthenticatorSelection,
    pub attestation: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AllowCredential {
    #[serde(rename = "type")]
    pub cred_type: String,
    pub id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublicKeyCredentialRequestOptions {
    pub challenge: String,
    pub timeout: u32,
    pub rp_id: String,
    pub allow_credentials: Vec<AllowCredential>,
    pub user_verification: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResponse {
    pub id: String,
    pub raw_id: String,
    #[serde(rename = "type")]
    pub cred_type: String,
    pub response: RegistrationResponseData,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResponseData {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub attestation_object: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationResponse {
    pub id: String,
    pub raw_id: String,
    #[serde(rename = "type")]
    pub cred_type: String,
    pub response: AuthenticationResponseData,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationResponseData {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub authenticator_data: String,
    pub signature: String,
    pub user_handle: Option<String>,
}

pub struct RelyingParty {
    rp_id: String,
    rp_origin: String,
    rp_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RegChallenge {
    pub challenge: String,
    pub user_id: String,
    pub username: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AuthChallenge {
    pub challenge: String,
    pub allowed_credential_ids: Vec<Vec<u8>>,
    pub owner_handle: Vec<u8>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct StoredCredential {
    pub cred_id: Vec<u8>,
    pub aaguid: [u8; 16],
    pub x: [u8; 32],
    pub y: [u8; 32],
    pub sign_count: u32,
    pub backup_eligible: bool,
    pub backup_state: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CounterResult {
    Unsupported,
    Increased { previous: u32, observed: u32 },
    NonIncreasing { previous: u32, observed: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticationFinish {
    pub credential: StoredCredential,
    pub counter: CounterResult,
}

#[derive(Debug, Clone, Copy)]
struct AuthenticatorData {
    sign_count: u32,
    backup_eligible: bool,
    backup_state: bool,
}

impl RelyingParty {
    pub fn new(rp_id: &str, rp_origin: &str, rp_name: &str) -> Self {
        Self {
            rp_id: rp_id.to_string(),
            rp_origin: rp_origin.to_string(),
            rp_name: rp_name.to_string(),
        }
    }



    pub fn start_registration(
        &self,
        user_id: &str,
        username: &str,
    ) -> Result<(PublicKeyCredentialCreationOptions, RegChallenge), WebAuthnError> {
        let challenge_bytes = random_bytes(32)?;
        let challenge = Base64UrlUnpadded::encode_string(&challenge_bytes);
        let user_id_b64 = Base64UrlUnpadded::encode_string(user_id.as_bytes());

        let options = PublicKeyCredentialCreationOptions {
            rp: RPInfo {
                id: self.rp_id.clone(),
                name: self.rp_name.clone(),
            },
            user: UserInfo {
                id: user_id_b64,
                name: username.to_string(),
                display_name: username.to_string(),
            },
            challenge: challenge.clone(),
            pub_key_cred_params: vec![PubKeyCredParam {
                cred_type: "public-key".into(),
                alg: -7,
            }],
            timeout: 60000,
            authenticator_selection: AuthenticatorSelection {
                resident_key: "required".into(),
                require_resident_key: true,
                user_verification: "required".into(),
            },
            attestation: "none".into(),
        };

        let reg_challenge = RegChallenge {
            challenge,
            user_id: user_id.to_string(),
            username: username.to_string(),
        };

        Ok((options, reg_challenge))
    }


    pub fn finish_registration(
        &self,
        response: &RegistrationResponse,
        state: &RegChallenge,
    ) -> Result<StoredCredential, WebAuthnError> {
        validate_credential_identity(&response.id, &response.raw_id, &response.cred_type)?;
        let cdj_bytes = b64url_decode_bounded(&response.response.client_data_json, MAX_CLIENT_DATA_BYTES)?;
        let cdj: serde_json::Value = serde_json::from_slice(&cdj_bytes)
            .map_err(|e| WebAuthnError::InvalidClientData(format!("clientDataJSON: {e}")))?;
        validate_client_data(&cdj, "webauthn.create", &state.challenge, &self.rp_origin)?;

        let attest_bytes = b64url_decode_bounded(&response.response.attestation_object, MAX_ATTESTATION_BYTES)?;
        let attest = decode_cbor_exact(&attest_bytes)
            .map_err(|error| WebAuthnError::InvalidAttestation(format!("attestationObject CBOR: {error}")))?;
        reject_duplicate_cbor_map_keys(&attest)
            .map_err(WebAuthnError::InvalidAttestation)?;

        let fmt = cbor_get_text(&attest, "fmt").ok_or_else(|| {
            WebAuthnError::InvalidAttestation("missing fmt in attestationObject".into())
        })?;

        let auth_data = cbor_get_bytes(&attest, "authData").ok_or_else(|| {
            WebAuthnError::InvalidAttestation("missing authData in attestationObject".into())
        })?;

        if fmt != "none" {
            return Err(WebAuthnError::InvalidAttestation(format!("unsupported attestation format: {fmt}")));
        }
        let statement = cbor_get_value(&attest, "attStmt")
            .ok_or_else(|| WebAuthnError::InvalidAttestation("missing attStmt".into()))?;
        if !matches!(statement, ciborium::value::Value::Map(entries) if entries.is_empty()) {
            return Err(WebAuthnError::InvalidAttestation("none attestation statement must be empty".into()));
        }
        let credential = parse_auth_data_registration(&self.rp_id, &auth_data)?;
        let response_id = b64url_decode_bounded(&response.raw_id, MAX_CREDENTIAL_ID_BYTES)?;
        if credential.cred_id != response_id {
            return Err(WebAuthnError::InvalidAttestation("credential id does not match rawId".into()));
        }
        Ok(credential)
    }



    pub fn start_authentication(
        &self,
        credentials: &[StoredCredential],
        owner_handle: &[u8],
    ) -> Result<(PublicKeyCredentialRequestOptions, AuthChallenge), WebAuthnError> {
        let challenge_bytes = random_bytes(32)?;
        let challenge = Base64UrlUnpadded::encode_string(&challenge_bytes);

        let allow_credentials = credentials
            .iter()
            .map(|c| {
                let id_b64 = Base64UrlUnpadded::encode_string(&c.cred_id);
                AllowCredential {
                    cred_type: "public-key".into(),
                    id: id_b64,
                }
            })
            .collect();

        let options = PublicKeyCredentialRequestOptions {
            challenge: challenge.clone(),
            timeout: 60000,
            rp_id: self.rp_id.clone(),
            allow_credentials,
            user_verification: "required".into(),
        };

        let auth_challenge = AuthChallenge {
            challenge,
            allowed_credential_ids: credentials.iter().map(|credential| credential.cred_id.clone()).collect(),
            owner_handle: owner_handle.to_vec(),
        };

        Ok((options, auth_challenge))
    }

    #[allow(deprecated)]
    pub fn finish_authentication(
        &self,
        response: &AuthenticationResponse,
        state: &AuthChallenge,
        cred: &StoredCredential,
    ) -> Result<AuthenticationFinish, WebAuthnError> {
        validate_credential_identity(&response.id, &response.raw_id, &response.cred_type)?;
        let response_id = b64url_decode_bounded(&response.raw_id, MAX_CREDENTIAL_ID_BYTES)?;
        if !state.allowed_credential_ids.iter().any(|credential_id| credential_id == &response_id)
            || cred.cred_id != response_id
        {
            return Err(WebAuthnError::CredentialNotFound);
        }
        let user_handle = response.response.user_handle.as_deref()
            .ok_or_else(|| WebAuthnError::InvalidClientData("missing userHandle".into()))?;
        if b64url_decode_bounded(user_handle, MAX_USER_HANDLE_BYTES)? != state.owner_handle {
            return Err(WebAuthnError::InvalidClientData("userHandle does not match owner".into()));
        }
        let cdj_bytes = b64url_decode_bounded(&response.response.client_data_json, MAX_CLIENT_DATA_BYTES)?;
        let cdj: serde_json::Value = serde_json::from_slice(&cdj_bytes)
            .map_err(|e| WebAuthnError::InvalidClientData(format!("clientDataJSON: {e}")))?;
        validate_client_data(&cdj, "webauthn.get", &state.challenge, &self.rp_origin)?;

        let auth_data = b64url_decode_bounded(&response.response.authenticator_data, MAX_AUTHENTICATOR_DATA_BYTES)?;
        let authenticator_data = parse_authenticator_data(&self.rp_id, &auth_data, false)?;


        let cdj_hash: [u8; 32] = sha256(&cdj_bytes);
        let mut signed = auth_data.clone();
        signed.extend_from_slice(&cdj_hash);

        let sig_bytes = b64url_decode_bounded(&response.response.signature, MAX_SIGNATURE_BYTES)
            .map_err(|_| WebAuthnError::InvalidSignature)?;
        let mut point = [0u8; 65];
        point[0] = 0x04;
        point[1..33].copy_from_slice(&cred.x);
        point[33..].copy_from_slice(&cred.y);
        let vk = VerifyingKey::<P256>::from_x962_uncompressed(&point)
            .map_err(|e| WebAuthnError::InvalidPublicKey(format!("invalid public key: {e}")))?;

        vk.verify_asn1::<Sha256>(&[&signed], &sig_bytes)
            .map_err(|_| WebAuthnError::InvalidSignature)?;

        let counter = counter_result(cred.sign_count, authenticator_data.sign_count);
        Ok(AuthenticationFinish {
            counter,
            credential: StoredCredential {
            cred_id: cred.cred_id.clone(),
            aaguid: cred.aaguid,
            x: cred.x,
            y: cred.y,
            sign_count: cred.sign_count.max(authenticator_data.sign_count),
            backup_eligible: cred.backup_eligible,
            backup_state: authenticator_data.backup_state,
            },
        })
    }
}

fn parse_auth_data_registration(
    rp_id: &str,
    auth_data: &[u8],
) -> Result<StoredCredential, WebAuthnError> {
    let authenticator_data = parse_authenticator_data(rp_id, auth_data, true)?;
    if auth_data[32] & 0x40 == 0 {
        return Err(WebAuthnError::InvalidAuthData(
            "no attested credential data present".into(),
        ));
    }
    let att = &auth_data[37..];
    if att.len() < 18 {
        return Err(WebAuthnError::InvalidAuthData(
            "attested credential data too short".into(),
        ));
    }
    let mut aaguid = [0u8; 16];
    aaguid.copy_from_slice(&att[..16]);
    let cred_id_len = u16::from_be_bytes([att[16], att[17]]) as usize;
    if att.len() < 18 + cred_id_len {
        return Err(WebAuthnError::InvalidAuthData(
            "credentialId truncated".into(),
        ));
    }
    let cred_id = att[18..18 + cred_id_len].to_vec();

    let cose_bytes = &att[18 + cred_id_len..];
    let (x, y, consumed) = parse_cose_p256(cose_bytes)?;
    validate_extension_data(&cose_bytes[consumed..], auth_data[32] & 0x80 != 0)?;
    let mut point = [0u8; 65];
    point[0] = 0x04;
    point[1..33].copy_from_slice(&x);
    point[33..].copy_from_slice(&y);
    VerifyingKey::<P256>::from_x962_uncompressed(&point)
        .map_err(|error| WebAuthnError::InvalidPublicKey(format!("invalid P-256 point: {error}")))?;

    Ok(StoredCredential {
        cred_id,
        aaguid,
        x,
        y,
        sign_count: authenticator_data.sign_count,
        backup_eligible: authenticator_data.backup_eligible,
        backup_state: authenticator_data.backup_state,
    })
}

fn parse_cose_p256(data: &[u8]) -> Result<([u8; 32], [u8; 32], usize), WebAuthnError> {
    if data.len() > 1_048_576 {
        return Err(WebAuthnError::InvalidCoseKey("COSE key too large".into()));
    }
    let mut cursor = std::io::Cursor::new(data);
    let value: ciborium::value::Value = ciborium::de::from_reader(&mut cursor)
        .map_err(|e| WebAuthnError::InvalidCoseKey(format!("COSE key CBOR: {e}")))?;
    if cursor.position() == 0 {
        return Err(WebAuthnError::InvalidCoseKey("empty COSE key".into()));
    }
    reject_duplicate_cbor_map_keys(&value).map_err(WebAuthnError::InvalidCoseKey)?;
    let map = match value {
        ciborium::value::Value::Map(m) => m,
        _ => {
            return Err(WebAuthnError::InvalidCoseKey(
                "COSE key is not a CBOR map".into(),
            ));
        }
    };

    let mut kty: Option<i64> = None;
    let mut alg: Option<i64> = None;
    let mut crv: Option<i64> = None;
    let mut x_bytes: Option<Vec<u8>> = None;
    let mut y_bytes: Option<Vec<u8>> = None;

    for (k, v) in map {
        let key_i = match k {
            ciborium::value::Value::Integer(i) => i64::try_from(i).ok(),
            _ => None,
        };
        match key_i {
            Some(1) => {
                kty = if let ciborium::value::Value::Integer(i) = v {
                    i64::try_from(i).ok()
                } else {
                    None
                }
            }
            Some(3) => {
                alg = if let ciborium::value::Value::Integer(i) = v {
                    i64::try_from(i).ok()
                } else {
                    None
                }
            }
            Some(-1) => {
                crv = if let ciborium::value::Value::Integer(i) = v {
                    i64::try_from(i).ok()
                } else {
                    None
                }
            }
            Some(-2) => {
                if let ciborium::value::Value::Bytes(b) = v {
                    x_bytes = Some(b);
                }
            }
            Some(-3) => {
                if let ciborium::value::Value::Bytes(b) = v {
                    y_bytes = Some(b);
                }
            }
            _ => {}
        }
    }

    if kty != Some(2) {
        return Err(WebAuthnError::InvalidCoseKey(format!(
            "unsupported COSE key type: {kty:?} (expected 2/EC2)"
        )));
    }
    if alg != Some(-7) {
        return Err(WebAuthnError::InvalidCoseKey(format!(
            "unsupported COSE algorithm: {alg:?} (expected -7/ES256)"
        )));
    }
    if crv != Some(1) {
        return Err(WebAuthnError::InvalidCoseKey(format!(
            "unsupported COSE curve: {crv:?} (expected 1/P-256)"
        )));
    }

    let x = x_bytes
        .ok_or_else(|| WebAuthnError::InvalidCoseKey("COSE key missing x coordinate".into()))?;
    let y = y_bytes
        .ok_or_else(|| WebAuthnError::InvalidCoseKey("COSE key missing y coordinate".into()))?;
    if x.len() != 32 || y.len() != 32 {
        return Err(WebAuthnError::InvalidCoseKey(format!(
            "unexpected coordinate length: x={}, y={}",
            x.len(),
            y.len()
        )));
    }
    let mut xa = [0u8; 32];
    let mut ya = [0u8; 32];
    xa.copy_from_slice(&x);
    ya.copy_from_slice(&y);
    Ok((xa, ya, cursor.position() as usize))
}

fn parse_authenticator_data(
    rp_id: &str,
    auth_data: &[u8],
    registration: bool,
) -> Result<AuthenticatorData, WebAuthnError> {
    if auth_data.len() < 37 {
        return Err(WebAuthnError::InvalidAuthData("authenticatorData too short".into()));
    }
    if auth_data.len() > 1_048_576 {
        return Err(WebAuthnError::InvalidAuthData("authenticatorData too large".into()));
    }
    if auth_data[..32] != sha256(rp_id.as_bytes()) {
        return Err(WebAuthnError::InvalidAuthData("rpIdHash mismatch".into()));
    }
    let flags = auth_data[32];
    if flags & 0x01 == 0 {
        return Err(WebAuthnError::InvalidAuthData("user not present".into()));
    }
    if flags & 0x04 == 0 {
        return Err(WebAuthnError::InvalidAuthData("user verification missing".into()));
    }
    if flags & 0x10 != 0 && flags & 0x08 == 0 {
        return Err(WebAuthnError::InvalidAuthData("backup state set without backup eligibility".into()));
    }
    if registration != (flags & 0x40 != 0) {
        return Err(WebAuthnError::InvalidAuthData("attested credential data flag does not match ceremony".into()));
    }
    if registration && flags & 0x80 == 0 && auth_data.len() == 37 {
        return Err(WebAuthnError::InvalidAuthData("attested credential data missing".into()));
    }
    if !registration {
        validate_extension_data(&auth_data[37..], flags & 0x80 != 0)?;
    }
    Ok(AuthenticatorData {
        sign_count: u32::from_be_bytes(auth_data[33..37].try_into().unwrap()),
        backup_eligible: flags & 0x08 != 0,
        backup_state: flags & 0x10 != 0,
    })
}

fn validate_extension_data(data: &[u8], extension_flag: bool) -> Result<(), WebAuthnError> {
    match (extension_flag, data.is_empty()) {
        (false, true) => Ok(()),
        (false, false) => Err(WebAuthnError::InvalidAuthData("unexpected extension data".into())),
        (true, true) => Err(WebAuthnError::InvalidAuthData("extension flag without extension data".into())),
        (true, false) => {
            let value = decode_cbor_exact(data)
                .map_err(|error| WebAuthnError::InvalidAuthData(format!("extension CBOR: {error}")))?;
            if !matches!(value, ciborium::value::Value::Map(_)) {
                return Err(WebAuthnError::InvalidAuthData("extension data must be a CBOR map".into()));
            }
            reject_duplicate_cbor_map_keys(&value).map_err(WebAuthnError::InvalidAuthData)
        }
    }
}

fn decode_cbor_exact(data: &[u8]) -> Result<ciborium::value::Value, String> {
    let mut cursor = std::io::Cursor::new(data);
    let value = ciborium::de::from_reader(&mut cursor).map_err(|error| error.to_string())?;
    if cursor.position() as usize != data.len() {
        return Err("trailing bytes after CBOR value".into());
    }
    Ok(value)
}

fn reject_duplicate_cbor_map_keys(value: &ciborium::value::Value) -> Result<(), String> {
    use ciborium::value::Value;
    match value {
        Value::Map(entries) => {
            for (index, (key, value)) in entries.iter().enumerate() {
                if entries[..index].iter().any(|(prior, _)| prior == key) {
                    return Err("duplicate CBOR map key".into());
                }
                reject_duplicate_cbor_map_keys(value)?;
                reject_duplicate_cbor_map_keys(key)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                reject_duplicate_cbor_map_keys(value)?;
            }
        }
        Value::Tag(_, value) => reject_duplicate_cbor_map_keys(value)?,
        _ => {}
    }
    Ok(())
}

fn validate_credential_identity(id: &str, raw_id: &str, credential_type: &str) -> Result<(), WebAuthnError> {
    if credential_type != "public-key" {
        return Err(WebAuthnError::InvalidClientData("credential type must be public-key".into()));
    }
    let id = b64url_decode_bounded(id, MAX_CREDENTIAL_ID_BYTES)?;
    let raw_id = b64url_decode_bounded(raw_id, MAX_CREDENTIAL_ID_BYTES)?;
    if id != raw_id || raw_id.is_empty() {
        return Err(WebAuthnError::InvalidClientData("id does not match rawId".into()));
    }
    Ok(())
}

fn validate_client_data(
    client_data: &serde_json::Value,
    expected_type: &str,
    expected_challenge: &str,
    expected_origin: &str,
) -> Result<(), WebAuthnError> {
    if client_data.get("type").and_then(serde_json::Value::as_str) != Some(expected_type) {
        return Err(WebAuthnError::InvalidClientData("wrong clientData type".into()));
    }
    let got = client_data.get("challenge").and_then(serde_json::Value::as_str)
        .ok_or_else(|| WebAuthnError::InvalidClientData("missing challenge in clientData".into()))?;
    if !ct_eq(got.as_bytes(), expected_challenge.as_bytes()) {
        return Err(WebAuthnError::ChallengeMismatch);
    }
    if client_data.get("origin").and_then(serde_json::Value::as_str) != Some(expected_origin) {
        return Err(WebAuthnError::OriginMismatch(format!("{:?}", client_data.get("origin"))));
    }
    if client_data.get("crossOrigin").and_then(serde_json::Value::as_bool) == Some(true)
        || client_data.get("topOrigin").is_some()
    {
        return Err(WebAuthnError::InvalidClientData("cross-origin ceremony rejected".into()));
    }
    Ok(())
}

fn cbor_get_value<'a>(value: &'a ciborium::value::Value, key: &str) -> Option<&'a ciborium::value::Value> {
    let ciborium::value::Value::Map(entries) = value else { return None; };
    entries.iter().find_map(|(candidate, value)| {
        matches!(candidate, ciborium::value::Value::Text(text) if text == key).then_some(value)
    })
}

fn counter_result(previous: u32, observed: u32) -> CounterResult {
    match (previous, observed) {
        (0, 0) => CounterResult::Unsupported,
        (previous, observed) if observed > previous => CounterResult::Increased { previous, observed },
        (previous, observed) => CounterResult::NonIncreasing { previous, observed },
    }
}

fn cbor_get_text(value: &ciborium::value::Value, key: &str) -> Option<String> {
    let ciborium::value::Value::Map(m) = value else {
        return None;
    };
    for (k, v) in m {
        if matches!(k, ciborium::value::Value::Text(t) if t == key)
            && let ciborium::value::Value::Text(t) = v
        {
            return Some(t.clone());
        }
    }
    None
}

fn cbor_get_bytes(value: &ciborium::value::Value, key: &str) -> Option<Vec<u8>> {
    let ciborium::value::Value::Map(m) = value else {
        return None;
    };
    for (k, v) in m {
        if matches!(k, ciborium::value::Value::Text(t) if t == key)
            && let ciborium::value::Value::Bytes(b) = v
        {
            return Some(b.clone());
        }
    }
    None
}

fn b64url_decode_bounded(s: &str, max_bytes: usize) -> Result<Vec<u8>, WebAuthnError> {
    let max_encoded_bytes = max_bytes.saturating_mul(4).saturating_add(2) / 3;
    if s.len() > max_encoded_bytes {
        return Err(WebAuthnError::DecodeError("base64url input too large".into()));
    }
    let bytes = Base64UrlUnpadded::decode_vec(s)
        .map_err(|e| WebAuthnError::DecodeError(format!("base64url decode: {e}")))
        ?;
    if bytes.len() > max_bytes {
        return Err(WebAuthnError::DecodeError("decoded input too large".into()));
    }
    Ok(bytes)
}

fn random_bytes(n: usize) -> Result<Vec<u8>, WebAuthnError> {
    let mut buf = vec![0u8; n];
    graviola::random::fill(&mut buf).map_err(|error| WebAuthnError::RandomSource(error.to_string()))?;
    Ok(buf)
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::hash(data)
        .as_ref()
        .try_into()
        .expect("SHA-256 output is 32 bytes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use graviola::signing::ecdsa::SigningKey;

    fn make_rp() -> RelyingParty {
        RelyingParty::new("example.com", "https://example.com", "Example")
    }


    struct SoftAuthenticator {
        signing_key: SigningKey<P256>,
        cred_id: Vec<u8>,
    }

    impl SoftAuthenticator {
        fn new() -> Self {
            Self::with_scalar(7)
        }



        fn with_scalar(scalar: u8) -> Self {

            let mut sec1 = vec![0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20];
            sec1.extend_from_slice(&[0u8; 31]);
            sec1.push(scalar);
            Self {
                signing_key: SigningKey::from_sec1_der(&sec1).unwrap(),
                cred_id: (1u8..=16).collect(),
            }
        }


        fn public_xy(&self) -> ([u8; 32], [u8; 32]) {
            let mut buf = [0u8; 128];
            let spki = self.signing_key.to_spki_der(&mut buf).unwrap();
            let point = &spki[spki.len() - 65..];
            assert_eq!(point[0], 0x04);
            (point[1..33].try_into().unwrap(), point[33..].try_into().unwrap())
        }

        fn sign_der(&self, message: &[u8]) -> Vec<u8> {
            let mut buf = [0u8; 80];
            self.signing_key
                .sign_asn1::<Sha256>(&[message], &mut buf)
                .unwrap()
                .to_vec()
        }

        fn cred_id_b64(&self) -> String {
            Base64UrlUnpadded::encode_string(&self.cred_id)
        }

        fn make_cose_key(&self) -> Vec<u8> {
            let (x, y) = self.public_xy();
            let (x, y) = (x.to_vec(), y.to_vec());
            let mut cbor = Vec::new();
            ciborium::ser::into_writer(
                &ciborium::value::Value::Map(vec![
                    (cbor_int(1), cbor_int(2)),
                    (cbor_int(3), cbor_int(-7)),
                    (cbor_int(-1), cbor_int(1)),
                    (cbor_int(-2), ciborium::value::Value::Bytes(x)),
                    (cbor_int(-3), ciborium::value::Value::Bytes(y)),
                ]),
                &mut cbor,
            )
            .unwrap();
            cbor
        }

        fn make_auth_data_with_cred(&self, rp_id: &str, flags: u8, cose_key: &[u8], credential_id: &[u8]) -> Vec<u8> {
            let rp_id_hash: [u8; 32] = sha256(rp_id.as_bytes());
            let mut auth_data = Vec::new();
            auth_data.extend_from_slice(&rp_id_hash);
            auth_data.push(flags);
            auth_data.extend_from_slice(&0u32.to_be_bytes());
            auth_data.extend_from_slice(&[0u8; 16]);
            auth_data.extend_from_slice(&(credential_id.len() as u16).to_be_bytes());
            auth_data.extend_from_slice(credential_id);
            auth_data.extend_from_slice(cose_key);
            auth_data
        }

        fn registration_response(
            &self,
            rp_id: &str,
            origin: &str,
            challenge: &str,
        ) -> serde_json::Value {
            let auth_data = self.make_auth_data_with_cred(rp_id, 0x45, &self.make_cose_key(), &self.cred_id);
            self.registration_response_with_auth_data(rp_id, origin, challenge, auth_data, "none", ciborium::value::Value::Map(vec![]))
        }

        fn registration_response_with_auth_data(
            &self,
            _: &str,
            origin: &str,
            challenge: &str,
            auth_data: Vec<u8>,
            format: &str,
            statement: ciborium::value::Value,
        ) -> serde_json::Value {

            let mut attest_obj = Vec::new();
            ciborium::ser::into_writer(
                &ciborium::value::Value::Map(vec![
                    (cbor_text("fmt"), cbor_text(format)),
                    (cbor_text("attStmt"), statement),
                    (
                        cbor_text("authData"),
                        ciborium::value::Value::Bytes(auth_data),
                    ),
                ]),
                &mut attest_obj,
            )
            .unwrap();

            let cdj = serde_json::json!({"type": "webauthn.create", "challenge": challenge, "origin": origin});
            let cdj_bytes = serde_json::to_vec(&cdj).unwrap();

            serde_json::json!({
                "id": self.cred_id_b64(),
                "rawId": self.cred_id_b64(),
                "type": "public-key",
                "response": {
                    "clientDataJSON": Base64UrlUnpadded::encode_string(&cdj_bytes),
                    "attestationObject": Base64UrlUnpadded::encode_string(&attest_obj),
                }
            })
        }

        fn authentication_response(
            &self,
            rp_id: &str,
            origin: &str,
            challenge: &str,
            sign_count: u32,
        ) -> serde_json::Value {
            self.authentication_response_with_flags(rp_id, origin, challenge, sign_count, 0x05)
        }

        fn authentication_response_with_flags(
            &self,
            rp_id: &str,
            origin: &str,
            challenge: &str,
            sign_count: u32,
            flags: u8,
        ) -> serde_json::Value {
            let rp_id_hash: [u8; 32] = sha256(rp_id.as_bytes());
            let mut auth_data = Vec::new();
            auth_data.extend_from_slice(&rp_id_hash);
            auth_data.push(flags);
            auth_data.extend_from_slice(&sign_count.to_be_bytes());

            let cdj = serde_json::json!({"type": "webauthn.get", "challenge": challenge, "origin": origin});
            let cdj_bytes = serde_json::to_vec(&cdj).unwrap();
            let cdj_hash: [u8; 32] = sha256(&cdj_bytes);

            let mut signed = auth_data.clone();
            signed.extend_from_slice(&cdj_hash);

            let sig_der = self.sign_der(&signed);

            serde_json::json!({
                "id": self.cred_id_b64(),
                "rawId": self.cred_id_b64(),
                "type": "public-key",
                "response": {
                    "clientDataJSON": Base64UrlUnpadded::encode_string(&cdj_bytes),
                    "authenticatorData": Base64UrlUnpadded::encode_string(&auth_data),
                    "signature": Base64UrlUnpadded::encode_string(&sig_der),
                    "userHandle": Base64UrlUnpadded::encode_string(b"uid-1"),
                }
            })
        }
    }

    fn cbor_int(i: i64) -> ciborium::value::Value {
        ciborium::value::Value::Integer(i.into())
    }

    fn cbor_text(s: &str) -> ciborium::value::Value {
        ciborium::value::Value::Text(s.to_string())
    }

    fn mutate_client_data(response: &mut serde_json::Value, field: &str, value: serde_json::Value) {
        let encoded = response["response"]["clientDataJSON"].as_str().unwrap();
        let bytes = Base64UrlUnpadded::decode_vec(encoded).unwrap();
        let mut client_data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        client_data[field] = value;
        response["response"]["clientDataJSON"] = Base64UrlUnpadded::encode_string(&serde_json::to_vec(&client_data).unwrap()).into();
    }

    fn mutate_attestation(response: &mut serde_json::Value, mutate: impl FnOnce(&mut ciborium::value::Value)) {
        let encoded = response["response"]["attestationObject"].as_str().unwrap();
        let bytes = Base64UrlUnpadded::decode_vec(encoded).unwrap();
        let mut attestation: ciborium::value::Value = ciborium::de::from_reader(bytes.as_slice()).unwrap();
        mutate(&mut attestation);
        let mut bytes = Vec::new();
        ciborium::ser::into_writer(&attestation, &mut bytes).unwrap();
        response["response"]["attestationObject"] = Base64UrlUnpadded::encode_string(&bytes).into();
    }

    fn mutate_registration_auth_data(response: &mut serde_json::Value, mutate: impl FnOnce(&mut Vec<u8>)) {
        mutate_attestation(response, |attestation| {
            let ciborium::value::Value::Map(entries) = attestation else { panic!("attestation must be a map"); };
            let auth_data = entries.iter_mut().find_map(|(key, value)| {
                (key == &cbor_text("authData")).then_some(value)
            }).unwrap();
            let ciborium::value::Value::Bytes(bytes) = auth_data else { panic!("authData must be bytes"); };
            mutate(bytes);
        });
    }

    fn mutate_registration_cose_key(response: &mut serde_json::Value, mutate: impl FnOnce(&mut ciborium::value::Value)) {
        mutate_registration_auth_data(response, |auth_data| {
            let id_len = u16::from_be_bytes([auth_data[53], auth_data[54]]) as usize;
            let cose_start = 55 + id_len;
            let mut cursor = std::io::Cursor::new(&auth_data[cose_start..]);
            let mut key: ciborium::value::Value = ciborium::de::from_reader(&mut cursor).unwrap();
            let consumed = cursor.position() as usize;
            let trailing = auth_data[cose_start + consumed..].to_vec();
            mutate(&mut key);
            let mut encoded = Vec::new();
            ciborium::ser::into_writer(&key, &mut encoded).unwrap();
            auth_data.truncate(cose_start);
            auth_data.extend_from_slice(&encoded);
            auth_data.extend_from_slice(&trailing);
        });
    }

    fn set_attestation_bytes(response: &mut serde_json::Value, bytes: &[u8]) {
        response["response"]["attestationObject"] = Base64UrlUnpadded::encode_string(bytes).into();
    }

    fn set_cbor_map_value(value: &mut ciborium::value::Value, target: i64, replacement: ciborium::value::Value) {
        let ciborium::value::Value::Map(entries) = value else { panic!("COSE key must be a map"); };
        let entry = entries.iter_mut().find(|(key, _)| key == &cbor_int(target)).unwrap();
        entry.1 = replacement;
    }

    fn decode_registration(response: serde_json::Value) -> RegistrationResponse {
        serde_json::from_value(response).unwrap()
    }

    fn do_register(rp: &RelyingParty, authn: &SoftAuthenticator) -> StoredCredential {
        let (opts, reg_state) = rp.start_registration("uid-1", "alice").unwrap();
        let challenge = opts.challenge.clone();
        let response_val =
            authn.registration_response("example.com", "https://example.com", &challenge);
        let response: RegistrationResponse = serde_json::from_value(response_val).unwrap();
        rp.finish_registration(&response, &reg_state).unwrap()
    }

    #[test]
    fn round_trip_registration_then_authentication() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();

        let cred = do_register(&rp, &authn);
        assert_eq!(cred.cred_id, authn.cred_id);
        assert_eq!(cred.sign_count, 0);

        let (auth_opts, auth_state) = rp.start_authentication(std::slice::from_ref(&cred), b"uid-1").unwrap();
        let challenge = auth_opts.challenge.clone();
        let response_val =
            authn.authentication_response("example.com", "https://example.com", &challenge, 1);
        let response: AuthenticationResponse = serde_json::from_value(response_val).unwrap();
        let updated = rp
            .finish_authentication(&response, &auth_state, &cred)
            .unwrap();

        assert_eq!(updated.credential.sign_count, 1);
        assert_eq!(updated.counter, CounterResult::Increased { previous: 0, observed: 1 });
    }

    #[test]
    fn wrong_challenge_rejected_at_registration() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        let (_, reg_state) = rp.start_registration("uid-1", "alice").unwrap();
        let response_val =
            authn.registration_response("example.com", "https://example.com", "wrong-challenge");
        let response: RegistrationResponse = serde_json::from_value(response_val).unwrap();
        assert!(rp.finish_registration(&response, &reg_state).is_err());
    }

    #[test]
    fn wrong_challenge_rejected_at_authentication() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        let cred = do_register(&rp, &authn);
        let (_, auth_state) = rp.start_authentication(std::slice::from_ref(&cred), b"uid-1").unwrap();
        let response_val = authn.authentication_response(
            "example.com",
            "https://example.com",
            "wrong-challenge",
            1,
        );
        let response: AuthenticationResponse = serde_json::from_value(response_val).unwrap();
        assert!(
            rp.finish_authentication(&response, &auth_state, &cred)
                .is_err()
        );
    }

    #[test]
    fn wrong_origin_rejected() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        let (opts, reg_state) = rp.start_registration("uid-1", "alice").unwrap();
        let challenge = opts.challenge.clone();
        let response_val =
            authn.registration_response("example.com", "https://evil.example.com", &challenge);
        let response: RegistrationResponse = serde_json::from_value(response_val).unwrap();
        assert!(rp.finish_registration(&response, &reg_state).is_err());
    }

    #[test]
    fn bad_signature_rejected() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        let cred = do_register(&rp, &authn);


        let imposter = SoftAuthenticator::with_scalar(99);

        let (auth_opts, auth_state) = rp.start_authentication(std::slice::from_ref(&cred), b"uid-1").unwrap();
        let challenge = auth_opts.challenge.clone();
        let response_val =
            imposter.authentication_response("example.com", "https://example.com", &challenge, 1);
        let response: AuthenticationResponse = serde_json::from_value(response_val).unwrap();
        assert!(
            rp.finish_authentication(&response, &auth_state, &cred)
                .is_err()
        );
    }

    #[test]
    fn wrong_rp_id_rejected() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        let (opts, reg_state) = rp.start_registration("uid-1", "alice").unwrap();
        let challenge = opts.challenge.clone();

        let response_val =
            authn.registration_response("attacker.com", "https://example.com", &challenge);
        let response: RegistrationResponse = serde_json::from_value(response_val).unwrap();
        assert!(rp.finish_registration(&response, &reg_state).is_err());
    }

    #[test]
    fn user_verification_is_required_at_both_ceremony_finishes() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        let (registration_options, registration_state) = rp.start_registration("uid-1", "alice").unwrap();
        assert_eq!(registration_options.authenticator_selection.user_verification, "required");
        let mut registration_value = authn.registration_response("example.com", "https://example.com", &registration_options.challenge);
        mutate_registration_auth_data(&mut registration_value, |auth_data| auth_data[32] &= !0x04);
        assert!(rp.finish_registration(&decode_registration(registration_value), &registration_state).is_err());

        let credential = do_register(&rp, &authn);
        let (authentication_options, authentication_state) = rp.start_authentication(std::slice::from_ref(&credential), b"uid-1").unwrap();
        assert_eq!(authentication_options.user_verification, "required");
        let response_value = authn.authentication_response_with_flags(
            "example.com", "https://example.com", &authentication_options.challenge, 1, 0x01,
        );
        let response: AuthenticationResponse = serde_json::from_value(response_value).unwrap();
        assert!(rp.finish_authentication(&response, &authentication_state, &credential).is_err());
    }

    #[test]
    fn binds_response_identity_allowed_credentials_and_owner_handle() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        let (options, state) = rp.start_registration("uid-1", "alice").unwrap();

        let mut response_value = authn.registration_response("example.com", "https://example.com", &options.challenge);
        response_value["type"] = "password".into();
        assert!(rp.finish_registration(&decode_registration(response_value), &state).is_err());

        let mut response_value = authn.registration_response("example.com", "https://example.com", &options.challenge);
        response_value["id"] = Base64UrlUnpadded::encode_string(b"different").into();
        assert!(rp.finish_registration(&decode_registration(response_value), &state).is_err());

        let mut response_value = authn.registration_response("example.com", "https://example.com", &options.challenge);
        mutate_registration_auth_data(&mut response_value, |auth_data| auth_data[55] ^= 0xff);
        assert!(rp.finish_registration(&decode_registration(response_value), &state).is_err());

        let credential = do_register(&rp, &authn);
        let (options, mut state) = rp.start_authentication(std::slice::from_ref(&credential), b"uid-1").unwrap();
        let mut response_value = authn.authentication_response("example.com", "https://example.com", &options.challenge, 1);
        response_value["type"] = "password".into();
        let response: AuthenticationResponse = serde_json::from_value(response_value).unwrap();
        assert!(rp.finish_authentication(&response, &state, &credential).is_err());

        let mut response_value = authn.authentication_response("example.com", "https://example.com", &options.challenge, 1);
        response_value["id"] = Base64UrlUnpadded::encode_string(b"different").into();
        let response: AuthenticationResponse = serde_json::from_value(response_value).unwrap();
        assert!(rp.finish_authentication(&response, &state, &credential).is_err());

        state.allowed_credential_ids = vec![b"different".to_vec()];
        let response_value = authn.authentication_response("example.com", "https://example.com", &options.challenge, 1);
        let response: AuthenticationResponse = serde_json::from_value(response_value).unwrap();
        assert!(rp.finish_authentication(&response, &state, &credential).is_err());

        let (owner_options, state) = rp.start_authentication(std::slice::from_ref(&credential), b"uid-1").unwrap();
        let mut response_value = authn.authentication_response("example.com", "https://example.com", &owner_options.challenge, 1);
        response_value["response"]["userHandle"] = Base64UrlUnpadded::encode_string(b"other-owner").into();
        let response: AuthenticationResponse = serde_json::from_value(response_value).unwrap();
        assert!(rp.finish_authentication(&response, &state, &credential).is_err());
    }

    #[test]
    fn rejects_unsupported_cose_parameters_invalid_points_and_duplicate_keys() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        for variant in 0..5 {
            let (options, state) = rp.start_registration("uid-1", "alice").unwrap();
            let mut response_value = authn.registration_response("example.com", "https://example.com", &options.challenge);
            mutate_registration_cose_key(&mut response_value, |key| {
                match variant {
                    0 => set_cbor_map_value(key, 1, cbor_int(3)),
                    1 => set_cbor_map_value(key, 3, cbor_int(-8)),
                    2 => set_cbor_map_value(key, -1, cbor_int(2)),
                    3 => {
                        set_cbor_map_value(key, -2, ciborium::value::Value::Bytes(vec![0; 32]));
                        set_cbor_map_value(key, -3, ciborium::value::Value::Bytes(vec![0; 32]));
                    }
                    _ => {
                        let ciborium::value::Value::Map(entries) = key else { panic!("COSE key must be a map"); };
                        entries.push((cbor_int(1), cbor_int(2)));
                    }
                }
            });
            assert!(rp.finish_registration(&decode_registration(response_value), &state).is_err());
        }
    }

    #[test]
    fn requires_attestation_and_extension_data_to_be_exact_and_flagged() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        let (options, state) = rp.start_registration("uid-1", "alice").unwrap();
        let mut packed = authn.registration_response("example.com", "https://example.com", &options.challenge);
        mutate_attestation(&mut packed, |attestation| set_cbor_map_text(attestation, "fmt", cbor_text("packed")));
        assert!(rp.finish_registration(&decode_registration(packed), &state).is_err());

        let mut duplicate = authn.registration_response("example.com", "https://example.com", &options.challenge);
        mutate_attestation(&mut duplicate, |attestation| {
            let ciborium::value::Value::Map(entries) = attestation else { panic!("attestation must be a map"); };
            entries.push((cbor_text("fmt"), cbor_text("none")));
        });
        assert!(rp.finish_registration(&decode_registration(duplicate), &state).is_err());

        let mut unflagged_extension = authn.registration_response("example.com", "https://example.com", &options.challenge);
        mutate_registration_auth_data(&mut unflagged_extension, |auth_data| auth_data.push(0xa0));
        assert!(rp.finish_registration(&decode_registration(unflagged_extension), &state).is_err());

        let mut valid_extension = authn.registration_response("example.com", "https://example.com", &options.challenge);
        mutate_registration_auth_data(&mut valid_extension, |auth_data| {
            auth_data[32] |= 0x80;
            auth_data.push(0xa0);
        });
        assert!(rp.finish_registration(&decode_registration(valid_extension), &state).is_ok());

        let mut missing_extension = authn.registration_response("example.com", "https://example.com", &options.challenge);
        mutate_registration_auth_data(&mut missing_extension, |auth_data| auth_data[32] |= 0x80);
        assert!(rp.finish_registration(&decode_registration(missing_extension), &state).is_err());

        let mut packed_data = authn.registration_response("example.com", "https://example.com", &options.challenge);
        let full_bytes = Base64UrlUnpadded::decode_vec(packed_data["response"]["attestationObject"].as_str().unwrap()).unwrap();
        for end in [0, 1, full_bytes.len() - 1] {
            let mut truncated = packed_data.clone();
            set_attestation_bytes(&mut truncated, &full_bytes[..end]);
            assert!(rp.finish_registration(&decode_registration(truncated), &state).is_err());
        }
        let mut trailing = full_bytes;
        trailing.push(0);
        set_attestation_bytes(&mut packed_data, &trailing);
        assert!(rp.finish_registration(&decode_registration(packed_data), &state).is_err());
    }

    fn set_cbor_map_text(value: &mut ciborium::value::Value, target: &str, replacement: ciborium::value::Value) {
        let ciborium::value::Value::Map(entries) = value else { panic!("CBOR value must be a map"); };
        let entry = entries.iter_mut().find(|(key, _)| key == &cbor_text(target)).unwrap();
        entry.1 = replacement;
    }

    #[test]
    fn rejects_cross_origin_data_backup_flag_errors_and_raw_signatures() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        for (field, value) in [("crossOrigin", serde_json::json!(true)), ("topOrigin", serde_json::json!("https://frame.example"))] {
            let (options, state) = rp.start_registration("uid-1", "alice").unwrap();
            let mut registration_value = authn.registration_response("example.com", "https://example.com", &options.challenge);
            mutate_client_data(&mut registration_value, field, value.clone());
            assert!(rp.finish_registration(&decode_registration(registration_value), &state).is_err());

            let credential = do_register(&rp, &authn);
            let (options, state) = rp.start_authentication(std::slice::from_ref(&credential), b"uid-1").unwrap();
            let mut authentication_value = authn.authentication_response("example.com", "https://example.com", &options.challenge, 1);
            mutate_client_data(&mut authentication_value, field, value);
            let response: AuthenticationResponse = serde_json::from_value(authentication_value).unwrap();
            assert!(rp.finish_authentication(&response, &state, &credential).is_err());
        }

        let (options, state) = rp.start_registration("uid-1", "alice").unwrap();
        let mut invalid_backup = authn.registration_response("example.com", "https://example.com", &options.challenge);
        mutate_registration_auth_data(&mut invalid_backup, |auth_data| auth_data[32] |= 0x10);
        assert!(rp.finish_registration(&decode_registration(invalid_backup), &state).is_err());

        let (options, state) = rp.start_registration("uid-1", "alice").unwrap();
        let mut valid_backup = authn.registration_response("example.com", "https://example.com", &options.challenge);
        mutate_registration_auth_data(&mut valid_backup, |auth_data| auth_data[32] |= 0x18);
        let backup_credential = rp.finish_registration(&decode_registration(valid_backup), &state).unwrap();
        assert!(backup_credential.backup_eligible);
        assert!(backup_credential.backup_state);

        let credential = do_register(&rp, &authn);
        let (options, state) = rp.start_authentication(std::slice::from_ref(&credential), b"uid-1").unwrap();
        let mut raw_signature = authn.authentication_response("example.com", "https://example.com", &options.challenge, 1);
        raw_signature["response"]["signature"] = Base64UrlUnpadded::encode_string(&[7; 64]).into();
        let response: AuthenticationResponse = serde_json::from_value(raw_signature).unwrap();
        assert_eq!(rp.finish_authentication(&response, &state, &credential), Err(WebAuthnError::InvalidSignature));
    }

    #[test]
    fn accepts_zero_counters_and_preserves_the_highest_observed_value() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        let mut credential = do_register(&rp, &authn);
        let (options, state) = rp.start_authentication(std::slice::from_ref(&credential), b"uid-1").unwrap();
        let response_value = authn.authentication_response("example.com", "https://example.com", &options.challenge, 0);
        let response: AuthenticationResponse = serde_json::from_value(response_value).unwrap();
        let result = rp.finish_authentication(&response, &state, &credential).unwrap();
        assert_eq!(result.counter, CounterResult::Unsupported);
        assert_eq!(result.credential.sign_count, 0);

        credential.sign_count = 5;
        let (options, state) = rp.start_authentication(std::slice::from_ref(&credential), b"uid-1").unwrap();
        let response_value = authn.authentication_response("example.com", "https://example.com", &options.challenge, 3);
        let response: AuthenticationResponse = serde_json::from_value(response_value).unwrap();
        let result = rp.finish_authentication(&response, &state, &credential).unwrap();
        assert_eq!(result.counter, CounterResult::NonIncreasing { previous: 5, observed: 3 });
        assert_eq!(result.credential.sign_count, 5);
    }

    #[test]
    fn rejects_padded_oversized_and_inconsistent_ids() {
        let rp = make_rp();
        let authn = SoftAuthenticator::new();
        let (options, state) = rp.start_registration("uid-1", "alice").unwrap();
        let mut padded = authn.registration_response("example.com", "https://example.com", &options.challenge);
        padded["id"] = format!("{}=", padded["id"].as_str().unwrap()).into();
        assert!(rp.finish_registration(&decode_registration(padded), &state).is_err());

        let mut oversized = authn.registration_response("example.com", "https://example.com", &options.challenge);
        oversized["rawId"] = "A".repeat(2_000).into();
        assert!(rp.finish_registration(&decode_registration(oversized), &state).is_err());

        let mut oversized_client_data = authn.registration_response("example.com", "https://example.com", &options.challenge);
        oversized_client_data["response"]["clientDataJSON"] = "A".repeat(100_000).into();
        assert!(rp.finish_registration(&decode_registration(oversized_client_data), &state).is_err());
    }
}

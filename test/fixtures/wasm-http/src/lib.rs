use wasi::http::types::{Fields, IncomingRequest, OutgoingBody, OutgoingResponse, ResponseOutparam};
struct App;
const BODY: &str = "hello wasm";
impl wasi::exports::http::incoming_handler::Guest for App {
    fn handle(_request: IncomingRequest, response: ResponseOutparam) {
        eprintln!("wasm request");
        let outgoing = OutgoingResponse::new(Fields::new());
        let body = outgoing.body().unwrap();
        ResponseOutparam::set(response, Ok(outgoing));
        body.write().unwrap().blocking_write_and_flush(BODY.as_bytes()).unwrap();
        OutgoingBody::finish(body, None).unwrap();
    }
}
wasi::http::proxy::export!(App);

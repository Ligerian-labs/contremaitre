use std::{env, fs, thread, time::Duration};

fn main() {
    println!("command:{}", env::var("MESSAGE").unwrap_or_default());
    match env::args().nth(1).as_deref() {
        Some("write") => {
            let path = "/data/result.txt";
            let previous = fs::read_to_string(path).unwrap_or_default();
            fs::write(path, format!("{previous}done\n")).unwrap();
        }
        Some("fail") => std::process::exit(7),
        Some("worker") => loop {
            thread::sleep(Duration::from_secs(1));
        },
        _ => {}
    }
}

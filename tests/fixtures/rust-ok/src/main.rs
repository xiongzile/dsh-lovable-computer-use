fn greet(name: &str) -> String {
    format!("hello {name}")
}

fn main() {
    let message = greet("world");
    println!("{message}");
}

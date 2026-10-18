#include "greeter.hpp"
#include <iostream>
#include <vector>

namespace demo {
Greeter::Greeter(std::string name) : name_(std::move(name)) {}
std::string Greeter::greet() const { return "hello " + name_; }
}

int main() {
  demo::Greeter greeter("world");
  std::vector<int> values{1, 2, 3};
  std::cout << greeter.greet() << values.size() << std::endl;
  return 0;
}
